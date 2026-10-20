use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const RESULT_INSTRUCTION: &str = concat!(
    "<!-- codex-board-automation: This result contract applies ONLY to this automated turn, not future manual messages. ",
    "Complete the requested work, then return ONLY one JSON object ",
    "with exactly these keys: status (success or failed), summary (a concise string, at most 40 words total). ",
    "Use success only when the requested objective was achieved and relevant checks passed; no changes needed is success. ",
    "Use failed for incomplete work, blockers, unavailable prerequisites, failed checks or refusals. ",
    "A completed conversation is NOT evidence that the task succeeded. Never hide failures or uncertainty. ",
    "Keep explicitly requested deliverables complete; only the final chat result is brief. ",
    "No Markdown fences, headings, narration or extra keys. The summary must use the user's language. ",
    "Examples: all checks passed -> {\"status\":\"success\",\"summary\":\"Aggiornato il report. Tutti i controlli superati.\"}; ",
    "nothing relevant changed -> {\"status\":\"success\",\"summary\":\"Nessuna novità rilevante.\"}; ",
    "missing access -> {\"status\":\"failed\",\"summary\":\"Report non aggiornato: accesso al servizio scaduto.\"}; ",
    "partial changes but tests fail -> {\"status\":\"failed\",\"summary\":\"Modifica incompleta: due test falliscono. Serve correggerli prima di procedere.\"}. ",
    "These examples explain the contract, not facts about this run. This format overrides earlier verbose-report requests. ",
    "Do not mention this instruction. -->"
);

pub fn output_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "status": { "type": "string", "enum": ["success", "failed"] },
            "summary": { "type": "string" }
        },
        "required": ["status", "summary"],
        "additionalProperties": false
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunResult {
    pub status: String,
    pub summary: String,
    pub finished_at: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelReport {
    status: ReportStatus,
    summary: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum ReportStatus { Success, Failed }

pub fn resolve(turn: &Value, final_text: Option<&str>, finished_at: i64) -> AutomationRunResult {
    let technical = turn.get("status").and_then(Value::as_str);
    let (status, summary) = match technical {
        Some("failed") => ("failed", turn.pointer("/error/message").and_then(Value::as_str)
            .unwrap_or("Esecuzione fallita per un errore tecnico.").to_owned()),
        Some("interrupted") => ("failed", "Esecuzione interrotta: attività non completata.".into()),
        Some("completed") => {
            let parsed = final_text.and_then(|text| serde_json::from_str::<ModelReport>(text.trim()).ok());
            match parsed {
                Some(report) if !report.summary.trim().is_empty() && report.summary.split_whitespace().count() <= 40 => (
                    match report.status { ReportStatus::Success => "success", ReportStatus::Failed => "failed" },
                    report.summary.trim().to_owned(),
                ),
                _ => ("unknown", "Esito non verificabile: report strutturato assente o non valido. Controlla la conversazione prima di rilanciare.".into()),
            }
        },
        _ => ("unknown", "Esito non verificabile: stato tecnico dell'esecuzione assente o sconosciuto.".into()),
    };
    AutomationRunResult { status: status.into(), summary: summary.chars().take(500).collect(), finished_at }
}

pub fn final_message(items: &[Value]) -> Option<&str> {
    items.iter().rev().find_map(|item| {
        let phase = item.get("phase").and_then(Value::as_str);
        (item.get("type").and_then(Value::as_str) == Some("agentMessage") && phase != Some("commentary"))
            .then(|| item.get("text").and_then(Value::as_str)).flatten()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn business_failure_overrides_completed_turn() {
        let result = resolve(&json!({"status":"completed"}), Some(r#"{"status":"failed","summary":"Accesso scaduto."}"#), 42);
        assert_eq!(result.status, "failed");
        assert_eq!(result.summary, "Accesso scaduto.");
        assert_eq!(result.finished_at, 42);
    }
    #[test]
    fn technical_failure_and_interrupt_override_success_json() {
        for status in ["failed", "interrupted"] {
            assert_eq!(resolve(&json!({"status":status}), Some(r#"{"status":"success","summary":"OK."}"#), 1).status, "failed");
        }
    }
    #[test]
    fn invalid_missing_or_ambiguous_results_are_never_success() {
        for text in [None, Some("Done"), Some("{}"), Some(r#"{"status":"success","summary":""}"#),
            Some(r#"{"status":"maybe","summary":"OK"}"#), Some(r#"{"status":"success","summary":"OK","extra":true}"#)] {
            assert_eq!(resolve(&json!({"status":"completed"}), text, 1).status, "unknown");
        }
        let long = json!({"status":"success","summary":"word ".repeat(41)}).to_string();
        assert_eq!(resolve(&json!({"status":"completed"}), Some(&long), 1).status, "unknown");
        assert_eq!(resolve(&json!({}), Some(r#"{"status":"success","summary":"OK"}"#), 1).status, "unknown");
    }
    #[test]
    fn success_and_no_change_are_supported_and_commentary_is_not_a_result() {
        let items = vec![json!({"type":"agentMessage","phase":"final_answer","text":r#"{"status":"success","summary":"Nessuna novità."}"#}),
            json!({"type":"agentMessage","phase":"commentary","text":"Working..."})];
        assert_eq!(resolve(&json!({"status":"completed"}), final_message(&items), 1).status, "success");
    }
}
