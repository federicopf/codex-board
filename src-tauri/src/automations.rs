use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::Mutex;

use crate::{
    codex::{CodexClient, TurnCoordinator},
    persistence,
    automation_result::AutomationRunResult,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum AutomationAction {
    RecurringMessage {
        thread_id: String,
        prompt: String,
        every_minutes: u64,
        next_run_at: i64,
    },
    ScheduledMessage {
        thread_id: String,
        prompt: String,
        run_at: i64,
    },
    CalendarMessage {
        thread_id: String,
        prompt: String,
        weekdays: Vec<u8>,
        minute_of_day: u16,
        timezone_offset_minutes: i32,
        next_run_at: i64,
    },
    CategoryPipeline {
        from_category: String,
        to_category: String,
        after_minutes: u64,
    },
    ScheduledCategoryPipeline {
        from_category: String,
        to_category: String,
        run_at: i64,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub action: AutomationAction,
    pub last_run_at: Option<i64>,
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_result: Option<AutomationRunResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_state: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum CreateAutomationAction {
    RecurringMessage {
        thread_id: String,
        prompt: String,
        every_minutes: u64,
        #[serde(default)]
        start_in_minutes: u64,
    },
    ScheduledMessage {
        thread_id: String,
        prompt: String,
        run_at: i64,
    },
    CalendarMessage {
        thread_id: String,
        prompt: String,
        weekdays: Vec<u8>,
        minute_of_day: u16,
        timezone_offset_minutes: i32,
    },
    CategoryPipeline {
        from_category: String,
        to_category: String,
        after_minutes: u64,
    },
    ScheduledCategoryPipeline {
        from_category: String,
        to_category: String,
        run_at: i64,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAutomationInput {
    pub name: String,
    pub action: CreateAutomationAction,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AutomationEnabledInput {
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedState {
    automations: Vec<Automation>,
    #[serde(default)]
    entered_at: HashMap<String, i64>,
}

pub struct AutomationStore {
    state: Mutex<PersistedState>,
    // Serialize edits with scheduler submissions, not with the duration of Codex turns.
    mutation: Mutex<()>,
    path: PathBuf,
    client: Arc<CodexClient>,
    coordinator: Arc<TurnCoordinator>,
}

impl AutomationStore {
    pub fn new(
        path: PathBuf,
        client: Arc<CodexClient>,
        coordinator: Arc<TurnCoordinator>,
    ) -> Arc<Self> {
        let mut state: PersistedState = persistence::load_json_or_default(&path);
        for item in &mut state.automations {
            if item.last_result.is_none() {
                if let Some(error) = item.last_error.as_ref() {
                    item.last_result = Some(AutomationRunResult { status: "failed".into(), summary: error.clone(), finished_at: item.last_run_at.unwrap_or(0) });
                }
            }
            item.run_state = None;
        }
        Arc::new(Self {
            state: Mutex::new(state),
            mutation: Mutex::new(()),
            path,
            client,
            coordinator,
        })
    }

    pub fn start(self: &Arc<Self>) {
        let outcomes = self.clone();
        let mut events = self.client.subscribe_events();
        tauri::async_runtime::spawn(async move {
            loop {
                let event = match events.recv().await {
                    Ok(event) => event,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                };
                if event.method == "board/automation/completed" {
                    if let Some(id) = event.params.get("automationId").and_then(serde_json::Value::as_str) {
                        let raw = event.params.get("status").and_then(serde_json::Value::as_str).unwrap_or("unknown");
                        let status = if raw == "completed" { "success" } else if raw == "interrupted" { "failed" } else { raw };
                        let summary = event.params.get("result").and_then(serde_json::Value::as_str).unwrap_or("Esito non verificabile.");
                        let finished = event.params.get("finishedAt").and_then(serde_json::Value::as_i64).unwrap_or_else(now_ms);
                        let _ = outcomes.record_completion(id, status, summary, finished).await;
                    }
                }
            }
        });
        let store = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
            loop {
                interval.tick().await;
                store.tick().await;
            }
        });
    }

    pub async fn list(&self) -> Vec<Automation> {
        let mut items = self.state.lock().await.automations.clone();
        for item in &mut items {
            item.run_state = self.coordinator.automation_run_state(&item.id).await;
        }
        items
    }

    pub async fn create(&self, input: CreateAutomationInput) -> Result<Automation, String> {
        let name = required(input.name, "Automation name")?;
        let action = build_action(input.action, None, now_ms())?;
        let automation = Automation {
            id: random_id(),
            name,
            enabled: true,
            action,
            last_run_at: None,
            last_error: None,
            last_result: None,
            run_state: None,
        };
        let mut state = self.state.lock().await;
        state.automations.push(automation.clone());
        self.persist(&state)?;
        drop(state);
        self.emit_updated().await;
        Ok(automation)
    }

    async fn record_completion(&self, id: &str, status: &str, summary: &str, finished_at: i64) -> Result<(), String> {
        let mut state = self.state.lock().await;
        let mut next = state.clone();
        let Some(item) = next.automations.iter_mut().find(|item| item.id == id) else { return Ok(()) };
        if item.last_result.as_ref().is_some_and(|previous| previous.finished_at > finished_at) { return Ok(()) }
        let status = match status { "success" | "failed" => status, _ => "unknown" };
        item.last_result = Some(AutomationRunResult { status: status.into(), summary: summary.chars().take(500).collect(), finished_at });
        item.last_error = (status != "success").then(|| summary.to_owned());
        item.last_run_at = Some(finished_at);
        self.persist(&next)?;
        *state = next;
        drop(state);
        self.emit_updated().await;
        Ok(())
    }

    pub async fn retry(&self, id: &str) -> Result<(), String> {
        let _mutation = self.mutation.lock().await;
        let automation = self.state.lock().await.automations.iter().find(|item| item.id == id).cloned()
            .ok_or_else(|| "Automation not found".to_owned())?;
        if automation.last_result.as_ref().is_some_and(|result| result.status == "success") {
            return Err("L'ultima esecuzione è già riuscita. Aggiorna l'elenco dei risultati.".into());
        }
        if let Some(state) = self.coordinator.automation_run_state(id).await {
            if state == "queued" { return self.coordinator.retry_pending_automation(id).await; }
            return Err("Automazione già in esecuzione o in coda: non verrà duplicata.".into());
        }
        match &automation.action {
            AutomationAction::RecurringMessage { thread_id, prompt, .. } |
            AutomationAction::ScheduledMessage { thread_id, prompt, .. } |
            AutomationAction::CalendarMessage { thread_id, prompt, .. } => {
                match self.coordinator.send_automation(thread_id.clone(), prompt.clone(), id.into(), automation.name.clone()).await {
                    Ok(_) => { self.emit_updated().await; Ok(()) },
                    Err(error) => {
                        self.record_completion(id, "failed", &error.message, now_ms()).await?;
                        self.emit_failed(&automation, Some(thread_id), error.message.clone()).await;
                        Err(error.message)
                    }
                }
            }
            AutomationAction::CategoryPipeline { from_category, to_category, .. } |
            AutomationAction::ScheduledCategoryPipeline { from_category, to_category, .. } => {
                let threads = self.client.list_threads().await.map_err(|error| error.message)?;
                let mut moved = 0;
                let mut failed = 0;
                for thread in threads.iter().filter(|thread| title_category(thread.name.as_deref()) == *from_category) {
                    if let AutomationAction::CategoryPipeline { after_minutes, .. } = &automation.action {
                        let entered = self.state.lock().await.entered_at.get(&format!("{id}:{}", thread.id)).copied();
                        if !entered.is_some_and(|entered| now_ms().saturating_sub(entered) >= minutes_ms(*after_minutes, "Pipeline delay").unwrap_or(i64::MAX)) { continue; }
                    }
                    let title = display_title(thread.name.as_deref(), thread.preview.as_deref());
                    if self.client.rename_thread(thread.id.clone(), format!("{to_category} - {title}")).await.is_ok() {
                        moved += 1;
                        self.state.lock().await.entered_at.remove(&format!("{id}:{}", thread.id));
                    }
                    else { failed += 1; }
                }
                let status = if failed == 0 { "success" } else { "failed" };
                let summary = format!("{moved} task spostati da {from_category} a {to_category}; {failed} non riusciti.");
                self.record_completion(id, status, &summary, now_ms()).await?;
                self.client.emit_local_event("board/automation/completed", json!({
                    "automationId": id, "automationName": automation.name, "status": status, "result": summary
                })).await;
                Ok(())
            }
        }
    }

    pub async fn update(
        &self,
        id: &str,
        input: CreateAutomationInput,
    ) -> Result<Automation, String> {
        let _mutation = self.mutation.lock().await;
        let mut state = self.state.lock().await;
        let index = state
            .automations
            .iter()
            .position(|item| item.id == id)
            .ok_or_else(|| "Automation not found".to_string())?;
        let result = edited_automation(&state.automations[index], input, now_ms())?;
        let same_source = matches!((&state.automations[index].action, &result.action),
            (AutomationAction::CategoryPipeline { from_category: old, .. },
             AutomationAction::CategoryPipeline { from_category: next, .. }) if old == next);
        let mut next = state.clone();
        next.automations[index] = result.clone();
        if !same_source {
            next.entered_at
                .retain(|key, _| !key.starts_with(&format!("{id}:")));
        }
        self.persist(&next)?;
        *state = next;
        drop(state);
        self.emit_updated().await;
        Ok(result)
    }

    pub async fn set_enabled(&self, id: &str, enabled: bool) -> Result<Automation, String> {
        let _mutation = self.mutation.lock().await;
        let mut state = self.state.lock().await;
        let automation = state
            .automations
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| "Automation not found".to_string())?;
        automation.enabled = enabled;
        automation.last_error = None;
        let result = automation.clone();
        if !enabled {
            state
                .entered_at
                .retain(|key, _| !key.starts_with(&format!("{id}:")));
        }
        self.persist(&state)?;
        drop(state);
        self.emit_updated().await;
        Ok(result)
    }

    pub async fn delete(&self, id: &str) -> Result<bool, String> {
        let _mutation = self.mutation.lock().await;
        let mut state = self.state.lock().await;
        let before = state.automations.len();
        state.automations.retain(|item| item.id != id);
        state
            .entered_at
            .retain(|key, _| !key.starts_with(&format!("{id}:")));
        let deleted = before != state.automations.len();
        if deleted {
            self.persist(&state)?;
        }
        drop(state);
        if deleted {
            self.emit_updated().await;
        }
        Ok(deleted)
    }

    async fn tick(&self) {
        let _mutation = self.mutation.lock().await;
        let now = now_ms();
        let mut changed = false;
        let automations = self.list().await;
        let needs_threads = automations.iter().any(|automation| {
            automation.enabled
                && matches!(
                    automation.action,
                    AutomationAction::CategoryPipeline { .. }
                        | AutomationAction::ScheduledCategoryPipeline { .. }
                )
        });
        let threads = if needs_threads {
            self.client.list_threads().await.ok()
        } else {
            None
        };

        for automation in automations.into_iter().filter(|item| item.enabled) {
            match automation.action.clone() {
                AutomationAction::RecurringMessage {
                    thread_id,
                    prompt,
                    every_minutes,
                    next_run_at,
                } if now >= next_run_at => {
                    let result = self
                        .coordinator
                        .send_automation(
                            thread_id.clone(),
                            prompt,
                            automation.id.clone(),
                            automation.name.clone(),
                        )
                        .await
                        .map(|_| ());
                    let error_message = result.err().map(|error| error.message);
                    let mut state = self.state.lock().await;
                    if let Some(current) = state
                        .automations
                        .iter_mut()
                        .find(|item| item.id == automation.id)
                    {
                        current.last_run_at = Some(now);
                        current.last_error = error_message.clone();
                        if let AutomationAction::RecurringMessage { next_run_at, .. } =
                            &mut current.action
                        {
                            *next_run_at =
                                coalesced_next_interval_run(now_ms(), *next_run_at, every_minutes);
                        }
                    }
                    let _ = self.persist(&state);
                    drop(state);
                    if let Some(message) = error_message {
                        self.emit_failed(&automation, Some(&thread_id), message)
                            .await;
                    }
                    changed = true;
                }
                AutomationAction::ScheduledMessage {
                    thread_id,
                    prompt,
                    run_at,
                } if now >= run_at => {
                    let result = self
                        .coordinator
                        .send_automation(
                            thread_id.clone(),
                            prompt,
                            automation.id.clone(),
                            automation.name.clone(),
                        )
                        .await
                        .map(|_| ());
                    let error_message = result.err().map(|error| error.message);
                    let mut state = self.state.lock().await;
                    if let Some(current) = state
                        .automations
                        .iter_mut()
                        .find(|item| item.id == automation.id)
                    {
                        current.last_run_at = Some(now);
                        current.last_error = error_message.clone();
                        current.enabled = false;
                    }
                    let _ = self.persist(&state);
                    drop(state);
                    if let Some(message) = error_message {
                        self.emit_failed(&automation, Some(&thread_id), message)
                            .await;
                    }
                    changed = true;
                }
                AutomationAction::CalendarMessage {
                    thread_id,
                    prompt,
                    weekdays,
                    minute_of_day,
                    timezone_offset_minutes,
                    next_run_at,
                } if now >= next_run_at => {
                    // A delayed scheduler tick sends this due occurrence once, then skips every
                    // missed calendar slot and advances directly to the next future one.
                    let result = self
                        .coordinator
                        .send_automation(
                            thread_id.clone(),
                            prompt,
                            automation.id.clone(),
                            automation.name.clone(),
                        )
                        .await
                        .map(|_| ());
                    let error_message = result.err().map(|error| error.message);
                    let mut state = self.state.lock().await;
                    if let Some(current) = state
                        .automations
                        .iter_mut()
                        .find(|item| item.id == automation.id)
                    {
                        current.last_run_at = Some(now);
                        current.last_error = error_message.clone();
                        if let AutomationAction::CalendarMessage { next_run_at, .. } =
                            &mut current.action
                        {
                            *next_run_at = next_calendar_run(
                                now_ms().saturating_add(60_000),
                                &weekdays,
                                minute_of_day,
                                timezone_offset_minutes,
                            );
                        }
                    }
                    let _ = self.persist(&state);
                    drop(state);
                    if let Some(message) = error_message {
                        self.emit_failed(&automation, Some(&thread_id), message)
                            .await;
                    }
                    changed = true;
                }
                AutomationAction::CategoryPipeline {
                    from_category,
                    to_category,
                    after_minutes,
                } => {
                    let Some(threads) = threads.as_ref() else {
                        continue;
                    };
                    let mut active_ids = Vec::new();
                    let mut tracking_changed = false;
                    for thread in threads {
                        if title_category(thread.name.as_deref()) != from_category {
                            continue;
                        }
                        active_ids.push(thread.id.clone());
                        let key = format!("{}:{}", automation.id, thread.id);
                        let entered = {
                            let mut state = self.state.lock().await;
                            if let Some(entered) = state.entered_at.get(&key) {
                                *entered
                            } else {
                                state.entered_at.insert(key.clone(), now);
                                tracking_changed = true;
                                now
                            }
                        };
                        if now.saturating_sub(entered)
                            < minutes_ms(after_minutes, "Pipeline delay").unwrap_or(i64::MAX)
                        {
                            continue;
                        }
                        let title =
                            display_title(thread.name.as_deref(), thread.preview.as_deref());
                        let result = self
                            .client
                            .rename_thread(thread.id.clone(), format!("{to_category} - {title}"))
                            .await
                            .map(|_| ());
                        let error = result.err();
                        let error_message = error.as_ref().map(|value| value.message.clone());
                        let mut state = self.state.lock().await;
                        if error_message.is_none() { state.entered_at.remove(&key); }
                        if let Some(current) = state
                            .automations
                            .iter_mut()
                            .find(|item| item.id == automation.id)
                        {
                            current.last_run_at = Some(now);
                            current.last_error = error_message.clone();
                        }
                        let _ = self.persist(&state);
                        drop(state);
                        self.client
                            .emit_local_event(
                                "board/automation/completed",
                                json!({
                                    "threadId": thread.id,
                                    "automationId": automation.id.clone(),
                                    "automationName": automation.name.clone(),
                                    "status": if error_message.is_some() { "failed" } else { "completed" },
                                    "result": error_message.unwrap_or_else(|| format!("Moved “{title}” from {from_category} to {to_category}.")),
                                }),
                            )
                            .await;
                        changed = true;
                    }
                    let prefix = format!("{}:", automation.id);
                    let mut state = self.state.lock().await;
                    let tracked_before = state.entered_at.len();
                    state.entered_at.retain(|key, _| {
                        !key.starts_with(&prefix)
                            || active_ids.iter().any(|id| key == &format!("{prefix}{id}"))
                    });
                    tracking_changed |= tracked_before != state.entered_at.len();
                    if tracking_changed {
                        let _ = self.persist(&state);
                    }
                }
                AutomationAction::ScheduledCategoryPipeline {
                    from_category,
                    to_category,
                    run_at,
                } if now >= run_at => {
                    let Some(threads) = threads.as_ref() else {
                        continue;
                    };
                    let mut errors = Vec::new();
                    let mut moved = 0_u64;
                    for thread in threads {
                        if title_category(thread.name.as_deref()) != from_category {
                            continue;
                        }
                        let title =
                            display_title(thread.name.as_deref(), thread.preview.as_deref());
                        if let Err(error) = self
                            .client
                            .rename_thread(thread.id.clone(), format!("{to_category} - {title}"))
                            .await
                        {
                            errors.push(error);
                        } else {
                            moved += 1;
                        }
                    }
                    let error_count = errors.len();
                    let mut state = self.state.lock().await;
                    if let Some(current) = state
                        .automations
                        .iter_mut()
                        .find(|item| item.id == automation.id)
                    {
                        current.last_run_at = Some(now);
                        current.last_error = if errors.is_empty() {
                            None
                        } else {
                            Some(format!("{} task(s) could not be moved", errors.len()))
                        };
                        if errors.is_empty() {
                            current.enabled = false;
                        } else if let AutomationAction::ScheduledCategoryPipeline {
                            run_at, ..
                        } = &mut current.action
                        {
                            *run_at = now.saturating_add(60_000);
                        }
                    }
                    let _ = self.persist(&state);
                    drop(state);
                    self.client
                        .emit_local_event(
                            "board/automation/completed",
                            json!({
                                "automationId": automation.id.clone(),
                                "automationName": automation.name.clone(),
                                "status": if error_count > 0 { "failed" } else { "completed" },
                                "result": if error_count > 0 {
                                    format!("Moved {moved} task(s) from {from_category} to {to_category}; {error_count} failed.")
                                } else {
                                    format!("Moved {moved} task(s) from {from_category} to {to_category}.")
                                },
                            }),
                        )
                        .await;
                    changed = true;
                }
                _ => {}
            }
        }
        if changed {
            self.emit_updated().await;
        }
    }

    fn persist(&self, state: &PersistedState) -> Result<(), String> {
        persistence::write_json(&self.path, state)
    }

    async fn emit_updated(&self) {
        self.client
            .emit_local_event("board/automations/updated", json!({}))
            .await;
    }

    async fn emit_failed(&self, automation: &Automation, thread_id: Option<&str>, result: String) {
        self.client
            .emit_local_event(
                "board/automation/completed",
                json!({
                    "threadId": thread_id,
                    "automationId": automation.id,
                    "automationName": automation.name,
                    "status": "failed",
                    "result": result,
                }),
            )
            .await;
    }
}

// Editing metadata must not postpone a due occurrence or change a calendar's timezone.
fn build_action(
    input: CreateAutomationAction,
    previous: Option<&AutomationAction>,
    now: i64,
) -> Result<AutomationAction, String> {
    let mut action = match input {
        CreateAutomationAction::RecurringMessage {
            thread_id,
            prompt,
            every_minutes,
            start_in_minutes,
        } => {
            minutes_ms(every_minutes, "Recurring interval")?;
            let start_ms = minutes_ms(start_in_minutes.max(1), "Start delay")?;
            AutomationAction::RecurringMessage {
                thread_id: required(thread_id, "Thread")?,
                prompt: required(prompt, "Prompt")?,
                every_minutes,
                next_run_at: now.saturating_add(start_ms),
            }
        }
        CreateAutomationAction::CategoryPipeline {
            from_category,
            to_category,
            after_minutes,
        } => {
            let from_category = category(from_category)?;
            let to_category = category(to_category)?;
            if from_category == to_category {
                return Err("Pipeline categories must be different".into());
            }
            minutes_ms(after_minutes, "Pipeline delay")?;
            AutomationAction::CategoryPipeline {
                from_category,
                to_category,
                after_minutes,
            }
        }
        CreateAutomationAction::ScheduledCategoryPipeline {
            from_category,
            to_category,
            run_at,
        } => {
            let from_category = category(from_category)?;
            let to_category = category(to_category)?;
            if from_category == to_category {
                return Err("Pipeline categories must be different".into());
            }
            if run_at <= now
                && !matches!(previous, Some(AutomationAction::ScheduledCategoryPipeline { run_at: old, .. }) if *old == run_at)
            {
                return Err("Pipeline time must be in the future".into());
            }
            AutomationAction::ScheduledCategoryPipeline {
                from_category,
                to_category,
                run_at,
            }
        }
        CreateAutomationAction::ScheduledMessage {
            thread_id,
            prompt,
            run_at,
        } => {
            if run_at <= now
                && !matches!(previous, Some(AutomationAction::ScheduledMessage { run_at: old, .. }) if *old == run_at)
            {
                return Err("Scheduled time must be in the future".into());
            }
            AutomationAction::ScheduledMessage {
                thread_id: required(thread_id, "Thread")?,
                prompt: required(prompt, "Prompt")?,
                run_at,
            }
        }
        CreateAutomationAction::CalendarMessage {
            thread_id,
            prompt,
            weekdays,
            minute_of_day,
            timezone_offset_minutes,
        } => {
            let weekdays = valid_weekdays(weekdays)?;
            if minute_of_day >= 24 * 60 {
                return Err("Calendar time is invalid".into());
            }
            if !(-14 * 60..=14 * 60).contains(&timezone_offset_minutes) {
                return Err("Timezone offset is invalid".into());
            }
            AutomationAction::CalendarMessage {
                thread_id: required(thread_id, "Thread")?,
                prompt: required(prompt, "Prompt")?,
                next_run_at: next_calendar_run(
                    now,
                    &weekdays,
                    minute_of_day,
                    timezone_offset_minutes,
                ),
                weekdays,
                minute_of_day,
                timezone_offset_minutes,
            }
        }
    };

    match (&mut action, previous) {
        (
            AutomationAction::RecurringMessage {
                every_minutes,
                next_run_at,
                ..
            },
            Some(AutomationAction::RecurringMessage {
                every_minutes: old_interval,
                next_run_at: old_next,
                ..
            }),
        ) if every_minutes == old_interval => *next_run_at = *old_next,
        (
            AutomationAction::CalendarMessage {
                weekdays,
                minute_of_day,
                timezone_offset_minutes,
                next_run_at,
                ..
            },
            Some(AutomationAction::CalendarMessage {
                weekdays: old_days,
                minute_of_day: old_minute,
                timezone_offset_minutes: old_offset,
                next_run_at: old_next,
                ..
            }),
        ) if weekdays == old_days
            && minute_of_day == old_minute
            && timezone_offset_minutes == old_offset =>
        {
            *next_run_at = *old_next
        }
        _ => {}
    }
    Ok(action)
}

fn edited_automation(
    current: &Automation,
    input: CreateAutomationInput,
    now: i64,
) -> Result<Automation, String> {
    Ok(Automation {
        name: required(input.name, "Automation name")?,
        action: build_action(input.action, Some(&current.action), now)?,
        ..current.clone()
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn required(value: String, label: &str) -> Result<String, String> {
    let value = value.trim().to_owned();
    if value.is_empty() {
        Err(format!("{label} is required"))
    } else {
        Ok(value)
    }
}

fn category(value: String) -> Result<String, String> {
    let value = required(value, "Category")?;
    if value.contains(" - ") {
        Err("Invalid category name".into())
    } else {
        Ok(value)
    }
}

fn minutes_ms(minutes: u64, label: &str) -> Result<i64, String> {
    if minutes == 0 {
        return Err(format!("{label} must be at least one minute"));
    }
    minutes
        .checked_mul(60_000)
        .and_then(|value| i64::try_from(value).ok())
        .ok_or_else(|| format!("{label} is too large"))
}

fn coalesced_next_interval_run(now: i64, scheduled_at: i64, every_minutes: u64) -> i64 {
    let interval_ms = minutes_ms(every_minutes, "Recurring interval").unwrap_or(i64::MAX);
    if now < scheduled_at {
        return scheduled_at;
    }
    let overdue_ms = now.saturating_sub(scheduled_at);
    // Advance from the stored cadence past every missed slot; the due branch itself
    // sends only one catch-up turn when the PC becomes available again.
    let intervals_to_next = overdue_ms.div_euclid(interval_ms).saturating_add(1);
    scheduled_at.saturating_add(interval_ms.saturating_mul(intervals_to_next))
}

fn valid_weekdays(mut weekdays: Vec<u8>) -> Result<Vec<u8>, String> {
    weekdays.sort_unstable();
    weekdays.dedup();
    if weekdays.is_empty() || weekdays.iter().any(|day| *day > 6) {
        Err("Select at least one valid weekday".into())
    } else {
        Ok(weekdays)
    }
}

fn next_calendar_run(
    now: i64,
    weekdays: &[u8],
    minute_of_day: u16,
    timezone_offset_minutes: i32,
) -> i64 {
    const DAY_MS: i64 = 86_400_000;
    let offset_ms = timezone_offset_minutes as i64 * 60_000;
    let local_now = now.saturating_sub(offset_ms);
    let local_day = local_now.div_euclid(DAY_MS);
    for days_ahead in 0..=7_i64 {
        let candidate_day = local_day + days_ahead;
        let weekday = (candidate_day + 4).rem_euclid(7) as u8;
        if !weekdays.contains(&weekday) {
            continue;
        }
        let candidate = candidate_day * DAY_MS + minute_of_day as i64 * 60_000 + offset_ms;
        if candidate > now {
            return candidate;
        }
    }
    now.saturating_add(7 * DAY_MS)
}

fn title_category(name: Option<&str>) -> String {
    name.and_then(|value| {
        value
            .split_once(" - ")
            .map(|(category, _)| category.trim().to_owned())
    })
    .filter(|value| !value.is_empty())
    .unwrap_or_else(|| "Uncategorized".into())
}

fn display_title(name: Option<&str>, preview: Option<&str>) -> String {
    name.and_then(|value| {
        value
            .split_once(" - ")
            .map(|(_, title)| title.trim().to_owned())
    })
    .filter(|value| !value.is_empty())
    .or_else(|| name.map(str::to_owned))
    .or_else(|| preview.map(str::to_owned))
    .unwrap_or_else(|| "Untitled task".into())
}

fn random_id() -> String {
    let mut bytes = [0_u8; 12];
    rand::rng().fill_bytes(&mut bytes);
    base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_helpers_preserve_category_and_title() {
        assert_eq!(title_category(Some("WIP - Ship it")), "WIP");
        assert_eq!(title_category(Some("No prefix")), "Uncategorized");
        assert_eq!(display_title(Some("WIP - Ship it"), None), "Ship it");
    }

    #[test]
    fn automation_actions_use_the_mobile_camel_case_contract() {
        let input: CreateAutomationInput = serde_json::from_value(json!({
            "name": "Move stale work",
            "action": {
                "kind": "categoryPipeline",
                "fromCategory": "WIP",
                "toCategory": "Review",
                "afterMinutes": 60
            }
        }))
        .unwrap();
        assert!(matches!(
            input.action,
            CreateAutomationAction::CategoryPipeline {
                after_minutes: 60,
                ..
            }
        ));
        let encoded = serde_json::to_value(AutomationAction::RecurringMessage {
            thread_id: "thread-1".into(),
            prompt: "Continue".into(),
            every_minutes: 30,
            next_run_at: 42,
        })
        .unwrap();
        assert_eq!(encoded["threadId"], "thread-1");
        assert_eq!(encoded["everyMinutes"], 30);

        let scheduled_pipeline: CreateAutomationInput = serde_json::from_value(json!({
            "name": "Ship Friday",
            "action": {
                "kind": "scheduledCategoryPipeline",
                "fromCategory": "Review",
                "toCategory": "Done",
                "runAt": 1_800_000_000_000_i64
            }
        }))
        .unwrap();
        assert!(matches!(
            scheduled_pipeline.action,
            CreateAutomationAction::ScheduledCategoryPipeline { .. }
        ));
    }

    #[test]
    fn calendar_schedule_uses_local_weekdays_and_time() {
        // 1970-01-01 was Thursday (weekday 4), at midnight UTC.
        assert_eq!(next_calendar_run(0, &[4], 60, 0), 3_600_000);
        assert_eq!(
            next_calendar_run(3_600_000, &[4], 60, 0),
            7 * 86_400_000 + 3_600_000
        );
        // UTC+1 is represented by JavaScript's getTimezoneOffset as -60.
        assert_eq!(next_calendar_run(0, &[4], 120, -60), 3_600_000);
    }

    fn edit_input(action: serde_json::Value) -> CreateAutomationInput {
        serde_json::from_value(json!({ "name": "Edited", "action": action })).unwrap()
    }

    #[test]
    fn editing_prompt_preserves_identity_pause_history_and_overdue_interval() {
        let original = Automation {
            id: "stable".into(), name: "Old".into(), enabled: false,
            action: AutomationAction::RecurringMessage { thread_id: "t".into(), prompt: "Old".into(), every_minutes: 60, next_run_at: 42 },
            last_run_at: Some(20), last_error: Some("Previous error".into()), last_result: None, run_state: None,
        };
        let input = edit_input(json!({ "kind": "recurringMessage", "threadId": "t", "prompt": "New", "everyMinutes": 60, "startInMinutes": 60 }));
        let result = edited_automation(&original, input, 100_000).unwrap();
        assert_eq!(result.id, "stable");
        assert_eq!(result.name, "Edited");
        assert!(!result.enabled);
        assert_eq!(result.last_run_at, Some(20));
        assert_eq!(result.last_error, original.last_error);
        assert!(matches!(result.action, AutomationAction::RecurringMessage { next_run_at: 42, prompt, .. } if prompt == "New"));
        let changed = build_action(edit_input(json!({ "kind": "recurringMessage", "threadId": "t", "prompt": "New", "everyMinutes": 30, "startInMinutes": 30 })).action, Some(&original.action), 100_000).unwrap();
        assert!(matches!(changed, AutomationAction::RecurringMessage { next_run_at: 1_900_000, every_minutes: 30, .. }));
    }

    #[test]
    fn editing_calendar_only_reschedules_changed_calendar_fields() {
        let previous = AutomationAction::CalendarMessage { thread_id: "t".into(), prompt: "Old".into(), weekdays: vec![1, 5], minute_of_day: 570, timezone_offset_minutes: -60, next_run_at: 42 };
        let action = |days| edit_input(json!({ "kind": "calendarMessage", "threadId": "t", "prompt": "New", "weekdays": days, "minuteOfDay": 570, "timezoneOffsetMinutes": -60 })).action;
        assert!(matches!(build_action(action(vec![5, 1]), Some(&previous), 100_000).unwrap(), AutomationAction::CalendarMessage { next_run_at: 42, .. }));
        assert!(matches!(build_action(action(vec![2]), Some(&previous), 100_000).unwrap(), AutomationAction::CalendarMessage { next_run_at, .. } if next_run_at > 100_000));
        assert!(build_action(action(Vec::<u8>::new()), Some(&previous), 100_000).is_err());
    }

    #[test]
    fn editing_past_one_off_is_allowed_only_when_date_is_unchanged() {
        for kind in ["scheduledMessage", "scheduledCategoryPipeline"] {
            let input = |run_at| edit_input(if kind == "scheduledMessage" {
                json!({ "kind": kind, "threadId": "t", "prompt": "New", "runAt": run_at })
            } else {
                json!({ "kind": kind, "fromCategory": "Custom", "toCategory": "Ship", "runAt": run_at })
            }).action;
            let previous = build_action(input(42), None, 0).unwrap();
            assert!(build_action(input(42), Some(&previous), 100).is_ok());
            assert!(build_action(input(41), Some(&previous), 100).is_err());
            assert!(build_action(input(200), Some(&previous), 100).is_ok());
            assert!(build_action(input(42), None, 100).is_err());
        }
    }

    #[tokio::test]
    async fn persisted_outcomes_survive_edits_and_stale_completions_and_retry_cannot_duplicate_queue() {
        let directory = std::env::temp_dir().join(format!("board-outcome-test-{}", random_id()));
        std::fs::create_dir_all(&directory).unwrap();
        let client = Arc::new(CodexClient::new());
        let path = directory.join("automations.json");
        let queue_path = directory.join("queues.json");
        let coordinator = TurnCoordinator::new(client.clone(), queue_path.clone());
        let store = AutomationStore::new(path.clone(), client.clone(), coordinator);
        let created = store.create(edit_input(json!({"kind":"recurringMessage","threadId":"t","prompt":"Check","everyMinutes":60,"startInMinutes":60}))).await.unwrap();
        store.set_enabled(&created.id, false).await.unwrap();
        store.record_completion(&created.id, "failed", "Missing access.", 200).await.unwrap();
        store.record_completion(&created.id, "success", "Stale", 100).await.unwrap();
        store.update(&created.id, edit_input(json!({"kind":"recurringMessage","threadId":"t","prompt":"New","everyMinutes":60,"startInMinutes":60}))).await.unwrap();
        persistence::write_json(&queue_path, &json!({"t":[{"id":"manual","text":"Earlier manual instruction"},{"id":"q","text":"New","automation":{"id":created.id,"name":"Review"}}]})).unwrap();
        let coordinator = TurnCoordinator::new(client.clone(), queue_path);
        let reloaded = AutomationStore::new(path, client, coordinator);
        assert_eq!(reloaded.list().await[0].last_result.as_ref().unwrap().status, "failed");
        assert_eq!(reloaded.list().await[0].last_result.as_ref().unwrap().finished_at, 200);
        assert!(!reloaded.list().await[0].enabled);
        assert_eq!(reloaded.list().await[0].run_state.as_deref(), Some("queued"));
        let next_run = match reloaded.list().await[0].action { AutomationAction::RecurringMessage { next_run_at, .. } => next_run_at, _ => unreachable!() };
        assert!(reloaded.retry(&created.id).await.unwrap_err().contains("già in esecuzione o in coda"));
        assert!(matches!(reloaded.list().await[0].action, AutomationAction::RecurringMessage { next_run_at, .. } if next_run_at == next_run));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn updates_persist_in_place_and_failed_edits_leave_state_untouched() {
        let directory = std::env::temp_dir().join(format!("board-automation-edit-{}", random_id()));
        std::fs::create_dir_all(&directory).unwrap();
        let client = Arc::new(CodexClient::new());
        let coordinator = TurnCoordinator::new(client.clone(), directory.join("queue.json"));
        let path = directory.join("automations.json");
        let store = AutomationStore::new(path.clone(), client.clone(), coordinator.clone());
        let created = store.create(edit_input(json!({ "kind": "categoryPipeline", "fromCategory": "Custom", "toCategory": "Review", "afterMinutes": 60 }))).await.unwrap();
        store.set_enabled(&created.id, false).await.unwrap();
        let key = format!("{}:task", created.id);
        store.state.lock().await.entered_at.insert(key.clone(), 42);
        let updated = store.update(&created.id, edit_input(json!({ "kind": "categoryPipeline", "fromCategory": "Custom", "toCategory": "Ship", "afterMinutes": 120 }))).await.unwrap();
        assert_eq!(created.id, updated.id);
        assert!(!updated.enabled);
        assert_eq!(store.state.lock().await.entered_at.get(&key), Some(&42));
        let reloaded = AutomationStore::new(path, client, coordinator);
        assert_eq!(reloaded.list().await.len(), 1);
        assert!(matches!(&reloaded.list().await[0].action, AutomationAction::CategoryPipeline { to_category, after_minutes: 120, .. } if to_category == "Ship"));
        assert!(store.update(&created.id, edit_input(json!({ "kind": "categoryPipeline", "fromCategory": "X", "toCategory": "X", "afterMinutes": 120 }))).await.is_err());
        assert!(matches!(&store.list().await[0].action, AutomationAction::CategoryPipeline { to_category, .. } if to_category == "Ship"));
        store.update(&created.id, edit_input(json!({ "kind": "categoryPipeline", "fromCategory": "Different", "toCategory": "Ship", "afterMinutes": 120 }))).await.unwrap();
        assert!(store.state.lock().await.entered_at.is_empty());
        assert_eq!(store.update("missing", edit_input(json!({ "kind": "categoryPipeline", "fromCategory": "X", "toCategory": "Y", "afterMinutes": 60 }))).await.unwrap_err(), "Automation not found");
        // The directory was uniquely created by this test, never a user persistence directory.
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn automation_minute_values_are_checked_without_overflow() {
        assert_eq!(minutes_ms(1, "Interval").unwrap(), 60_000);
        assert_eq!(
            minutes_ms(0, "Interval").unwrap_err(),
            "Interval must be at least one minute"
        );
        assert_eq!(
            minutes_ms(u64::MAX, "Interval").unwrap_err(),
            "Interval is too large"
        );
    }

    #[test]
    fn missed_interval_runs_coalesce_and_keep_the_schedule_cadence() {
        let scheduled_at = 1_000_000_i64;
        let interval_ms = 60 * 60_000;
        let now = scheduled_at + 3 * interval_ms + 20_000;
        assert_eq!(
            coalesced_next_interval_run(now, scheduled_at, 60),
            scheduled_at + 4 * interval_ms
        );
    }
}
