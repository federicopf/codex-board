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

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedState {
    automations: Vec<Automation>,
    #[serde(default)]
    entered_at: HashMap<String, i64>,
}

pub struct AutomationStore {
    state: Mutex<PersistedState>,
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
        let state = persistence::load_json_or_default(&path);
        Arc::new(Self {
            state: Mutex::new(state),
            path,
            client,
            coordinator,
        })
    }

    pub fn start(self: &Arc<Self>) {
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
        self.state.lock().await.automations.clone()
    }

    pub async fn create(&self, input: CreateAutomationInput) -> Result<Automation, String> {
        let name = required(input.name, "Automation name")?;
        let action = match input.action {
            CreateAutomationAction::RecurringMessage {
                thread_id,
                prompt,
                every_minutes,
                start_in_minutes,
            } => {
                if every_minutes == 0 {
                    return Err("Recurring interval must be at least one minute".into());
                }
                AutomationAction::RecurringMessage {
                    thread_id: required(thread_id, "Thread")?,
                    prompt: required(prompt, "Prompt")?,
                    every_minutes,
                    next_run_at: now_ms().saturating_add((start_in_minutes.max(1) * 60_000) as i64),
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
                if after_minutes == 0 {
                    return Err("Pipeline delay must be at least one minute".into());
                }
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
                if run_at <= now_ms() {
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
                if run_at <= now_ms() {
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
                        now_ms(),
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
        let automation = Automation {
            id: random_id(),
            name,
            enabled: true,
            action,
            last_run_at: None,
            last_error: None,
        };
        let mut state = self.state.lock().await;
        state.automations.push(automation.clone());
        self.persist(&state)?;
        drop(state);
        self.emit_updated().await;
        Ok(automation)
    }

    pub async fn set_enabled(&self, id: &str, enabled: bool) -> Result<Automation, String> {
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
                    let result = self.coordinator.send(thread_id, prompt).await.map(|_| ());
                    let mut state = self.state.lock().await;
                    if let Some(current) = state
                        .automations
                        .iter_mut()
                        .find(|item| item.id == automation.id)
                    {
                        current.last_run_at = Some(now);
                        current.last_error = result.err().map(|error| error.message);
                        if let AutomationAction::RecurringMessage { next_run_at, .. } =
                            &mut current.action
                        {
                            *next_run_at = now.saturating_add((every_minutes * 60_000) as i64);
                        }
                    }
                    let _ = self.persist(&state);
                    changed = true;
                }
                AutomationAction::ScheduledMessage {
                    thread_id,
                    prompt,
                    run_at,
                } if now >= run_at => {
                    let result = self.coordinator.send(thread_id, prompt).await.map(|_| ());
                    let mut state = self.state.lock().await;
                    if let Some(current) = state
                        .automations
                        .iter_mut()
                        .find(|item| item.id == automation.id)
                    {
                        current.last_run_at = Some(now);
                        current.last_error = result.err().map(|error| error.message);
                        current.enabled = false;
                    }
                    let _ = self.persist(&state);
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
                    let result = self.coordinator.send(thread_id, prompt).await.map(|_| ());
                    let mut state = self.state.lock().await;
                    if let Some(current) = state
                        .automations
                        .iter_mut()
                        .find(|item| item.id == automation.id)
                    {
                        current.last_run_at = Some(now);
                        current.last_error = result.err().map(|error| error.message);
                        if let AutomationAction::CalendarMessage { next_run_at, .. } =
                            &mut current.action
                        {
                            *next_run_at = next_calendar_run(
                                now.saturating_add(60_000),
                                &weekdays,
                                minute_of_day,
                                timezone_offset_minutes,
                            );
                        }
                    }
                    let _ = self.persist(&state);
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
                    for thread in threads {
                        if title_category(thread.name.as_deref()) != from_category {
                            continue;
                        }
                        active_ids.push(thread.id.clone());
                        let key = format!("{}:{}", automation.id, thread.id);
                        let entered = {
                            let mut state = self.state.lock().await;
                            *state.entered_at.entry(key.clone()).or_insert(now)
                        };
                        if now.saturating_sub(entered) < (after_minutes * 60_000) as i64 {
                            continue;
                        }
                        let title =
                            display_title(thread.name.as_deref(), thread.preview.as_deref());
                        let result = self
                            .client
                            .rename_thread(thread.id.clone(), format!("{to_category} - {title}"))
                            .await
                            .map(|_| ());
                        let mut state = self.state.lock().await;
                        state.entered_at.remove(&key);
                        if let Some(current) = state
                            .automations
                            .iter_mut()
                            .find(|item| item.id == automation.id)
                        {
                            current.last_run_at = Some(now);
                            current.last_error = result.err().map(|error| error.message);
                        }
                        let _ = self.persist(&state);
                        changed = true;
                    }
                    let prefix = format!("{}:", automation.id);
                    let mut state = self.state.lock().await;
                    state.entered_at.retain(|key, _| {
                        !key.starts_with(&prefix)
                            || active_ids.iter().any(|id| key == &format!("{prefix}{id}"))
                    });
                    let _ = self.persist(&state);
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
                        }
                    }
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
                        current.enabled = false;
                    }
                    let _ = self.persist(&state);
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
}
