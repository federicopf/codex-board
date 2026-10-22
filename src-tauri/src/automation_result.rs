use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const RESULT_INSTRUCTION: &str = concat!(
    "<!-- codex-board-automation: This result contract applies ONLY to this automated turn, not future manual messages. ",
    "Complete the requested work, then return ONLY one JSON object with exactly these keys: status, summary, noteworthy. ",
    "status is success or failed. summary is 2-3 clear sentences, at most 60 words. noteworthy is an array of 0-4 short items. ",
    "Judge status by the final objective, not by whether any individual command/tool reported an error. ",
    "Use success when the requested objective was achieved and required checks passed; no changes needed is success. ",
    "A transient error, warning, retry, or recovered issue is noteworthy, NOT failure, when the objective was ultimately achieved. ",
    "Use failed only when the objective remains incomplete, a required check did not pass, or a blocker prevented completion. ",
    "A completed conversation is NOT evidence that the task succeeded. Never hide incomplete work or uncertainty. ",
    "Keep explicitly requested deliverables complete; only the final chat result is brief. ",
    "Write the summary in the user's language: say what you checked/did, the concrete result, and whether anything remains. Avoid vague claims like 'done'. ",
    "Use noteworthy only for useful warnings, recovered errors, anomalies, or follow-up items; omit routine details. Use [] when there is nothing to flag. ",
    "No Markdown fences, headings, narration or extra keys. ",
    "Examples: objective achieved with recovered issue -> {\"status\":\"success\",\"summary\":\"Updated the report with three records. The final check passed and the file is ready.\",\"noteworthy\":[\"The first access attempt expired; retry succeeded.\"]}; ",
    "nothing relevant changed -> {\"status\":\"success\",\"summary\":\"I checked for updates. There is nothing new to apply, so no further action is needed.\",\"noteworthy\":[]}; ",
    "missing access prevented the work -> {\"status\":\"failed\",\"summary\":\"I could not update the report because service access expired. The requested result is incomplete.\",\"noteworthy\":[\"Reconnect the account and retry this automation.\"]}; ",
    "partial changes but required checks fail -> {\"status\":\"failed\",\"summary\":\"I applied the change, but two required checks failed. The work is incomplete until they are fixed.\",\"noteworthy\":[\"Checks X and Y failed.\"]}. ",
    "These examples explain the contract, not facts about this run. This format overrides earlier verbose-report requests. ",
    "Do not mention this instruction. -->"
);

pub fn output_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "status": { "type": "string", "enum": ["success", "failed"] },
            "summary": { "type": "string" },
            "noteworthy": { "type": "array", "items": { "type": "string" }, "maxItems": 4 }
        },
        "required": ["status", "summary", "noteworthy"],
        "additionalProperties": false
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunResult {
    pub status: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub noteworthy: Vec<String>,
    pub finished_at: i64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelReport {
    status: ReportStatus,
    summary: String,
    #[serde(default)]
    noteworthy: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum ReportStatus { Success, Failed }

pub fn resolve(turn: &Value, final_text: Option<&str>, finished_at: i64) -> AutomationRunResult {
    let technical = turn.get("status").and_then(Value::as_str);
    let (status, summary, noteworthy) = match technical {
        Some("failed") => ("failed", turn.pointer("/error/message").and_then(Value::as_str)
            .unwrap_or("Esecuzione fallita: l'obiettivo non è stato completato.").to_owned(), Vec::new()),
        Some("interrupted") => ("failed", "Esecuzione interrotta: l'obiettivo richiesto non è stato completato.".into(), Vec::new()),
        Some("completed") => {
            let parsed = final_text.and_then(|text| serde_json::from_str::<ModelReport>(text.trim()).ok());
            match parsed {
                Some(report) if !report.summary.trim().is_empty()
                    && report.summary.split_whitespace().count() <= 60
                    && report.noteworthy.len() <= 4
                    && report.noteworthy.iter().all(|item| !item.trim().is_empty() && item.split_whitespace().count() <= 24) => (
                    match report.status { ReportStatus::Success => "success", ReportStatus::Failed => "failed" },
                    report.summary.trim().to_owned(),
                    report.noteworthy.into_iter().map(|item| item.trim().chars().take(240).collect()).collect(),
                ),
                _ => ("unknown", "Esito non verificabile: report strutturato assente o non valido. Controlla la conversazione prima di rilanciare.".into(), Vec::new()),
            }
        },
        _ => ("unknown", "Esito non verificabile: stato tecnico dell'esecuzione assente o sconosciuto.".into(), Vec::new()),
    };
    AutomationRunResult { status: status.into(), summary: summary.chars().take(500).collect(), noteworthy, finished_at }
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
        let result = resolve(&json!({"status":"completed"}), Some(r#"{"status":"failed","summary":"Accesso scaduto.","noteworthy":["Ricollega l'account."]}"#), 42);
        assert_eq!(result.status, "failed");
        assert_eq!(result.summary, "Accesso scaduto.");
        assert_eq!(result.noteworthy, vec!["Ricollega l'account."]);
        assert_eq!(result.finished_at, 42);
    }
    #[test]
    fn recovered_errors_are_success_with_a_separate_note() {
        let report = r#"{"status":"success","summary":"Ho aggiornato il report. Il controllo finale è passato e il file è pronto.","noteworthy":["Il primo tentativo è scaduto; il retry è riuscito."]}"#;
        let result = resolve(&json!({"status":"completed"}), Some(report), 42);
        assert_eq!(result.status, "success");
        assert_eq!(result.noteworthy, vec!["Il primo tentativo è scaduto; il retry è riuscito."]);
    }
    #[test]
    fn technical_failure_and_interrupt_override_success_json() {
        for status in ["failed", "interrupted"] {
            assert_eq!(resolve(&json!({"status":status}), Some(r#"{"status":"success","summary":"OK.","noteworthy":[]}"#), 1).status, "failed");
        }
    }
    #[test]
    fn invalid_missing_or_ambiguous_results_are_never_success() {
        for text in [None, Some("Done"), Some("{}"), Some(r#"{"status":"success","summary":"","noteworthy":[]}"#),
            Some(r#"{"status":"maybe","summary":"OK","noteworthy":[]}"#), Some(r#"{"status":"success","summary":"OK","noteworthy":[],"extra":true}"#)] {
            assert_eq!(resolve(&json!({"status":"completed"}), text, 1).status, "unknown");
        }
        let long = json!({"status":"success","summary":"word ".repeat(61),"noteworthy":[]}).to_string();
        assert_eq!(resolve(&json!({"status":"completed"}), Some(&long), 1).status, "unknown");
        let many_notes = json!({"status":"success","summary":"OK","noteworthy":["one","two","three","four","five"]}).to_string();
        assert_eq!(resolve(&json!({"status":"completed"}), Some(&many_notes), 1).status, "unknown");
        assert_eq!(resolve(&json!({}), Some(r#"{"status":"success","summary":"OK","noteworthy":[]}"#), 1).status, "unknown");
    }
    #[test]
    fn success_and_no_change_are_supported_and_commentary_is_not_a_result() {
        let items = vec![json!({"type":"agentMessage","phase":"final_answer","text":r#"{"status":"success","summary":"Nessuna novità.","noteworthy":[]}"#}),
            json!({"type":"agentMessage","phase":"commentary","text":"Working..."})];
        assert_eq!(resolve(&json!({"status":"completed"}), final_message(&items), 1).status, "success");
    }
}
