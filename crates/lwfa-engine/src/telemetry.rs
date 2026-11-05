//! Opt-in, bounded stage timing. Durations are local monotonic CPU measurements,
//! not GPU timestamps or a claim about physical presentation latency.
use lwfa_proto::{PerformanceCounter, PerformanceStage};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    sync::{
        LazyLock, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
const MAX_SAMPLES: usize = 256;
const WINDOW: Duration = Duration::from_secs(2);
static ORIGIN: LazyLock<Instant> = LazyLock::new(Instant::now);
static ENABLED_UNTIL: AtomicU64 = AtomicU64::new(0);
static METRICS: LazyLock<Mutex<Recorder>> = LazyLock::new(|| Mutex::new(Recorder::default()));
fn clock_ms() -> u64 {
    ORIGIN.elapsed().as_millis().min(u64::MAX as u128) as u64
}
pub fn enabled() -> bool {
    let until = ENABLED_UNTIL.load(Ordering::Relaxed);
    until != 0 && clock_ms() < until
}
pub fn now() -> Option<Instant> {
    enabled().then(Instant::now)
}
pub fn observe(name: &'static str, duration: Duration) {
    if enabled() {
        if let Ok(mut recorder) = METRICS.lock() {
            recorder.observe(name, duration.as_secs_f64() * 1000.0, Instant::now());
        }
    }
}
pub fn count(name: &'static str) {
    if enabled() {
        if let Ok(mut recorder) = METRICS.lock() {
            *recorder.counts.entry(name).or_default() += 1;
        }
    }
}
pub fn rtt(session: u64, duration: Duration) {
    if enabled() {
        if let Ok(mut recorder) = METRICS.lock() {
            if recorder.rtts.len() < 64 || recorder.rtts.contains_key(&session) {
                recorder
                    .rtts
                    .insert(session, (Instant::now(), duration.as_secs_f64() * 1000.0));
            }
        }
    }
}
pub fn forget(session: u64) {
    if let Ok(mut recorder) = METRICS.lock() {
        recorder.rtts.remove(&session);
        recorder.queries.remove(&session);
    }
}
pub fn snapshot(
    session: u64,
) -> Option<(Vec<PerformanceStage>, Vec<PerformanceCounter>, Option<f64>)> {
    let mut recorder = METRICS.lock().ok()?;
    let now = Instant::now();
    if !recorder.admit_query(session, now) {
        return None;
    }
    ENABLED_UNTIL.store(clock_ms().saturating_add(5000), Ordering::Relaxed);
    Some(recorder.snapshot(session, now))
}
pub struct Span {
    name: &'static str,
    start: Option<Instant>,
}
impl Span {
    pub fn new(name: &'static str) -> Self {
        Self { name, start: now() }
    }
}
impl Drop for Span {
    fn drop(&mut self) {
        if let Some(start) = self.start {
            observe(self.name, start.elapsed());
        }
    }
}
#[derive(Default)]
struct Recorder {
    samples: BTreeMap<&'static str, VecDeque<(Instant, f64)>>,
    counts: BTreeMap<&'static str, u64>,
    rtts: HashMap<u64, (Instant, f64)>,
    queries: HashMap<u64, Instant>,
}
impl Recorder {
    fn admit_query(&mut self, session: u64, now: Instant) -> bool {
        if self
            .queries
            .get(&session)
            .is_some_and(|last| now.saturating_duration_since(*last) < Duration::from_millis(500))
        {
            return false;
        }
        if self.queries.len() >= 64 && !self.queries.contains_key(&session) {
            return false;
        }
        self.queries.insert(session, now);
        true
    }
    fn observe(&mut self, name: &'static str, value: f64, at: Instant) {
        if !value.is_finite() || value < 0.0 {
            return;
        }
        let samples = self.samples.entry(name).or_default();
        if samples.len() == MAX_SAMPLES {
            samples.pop_front();
        }
        samples.push_back((at, value));
    }
    fn snapshot(
        &mut self,
        session: u64,
        at: Instant,
    ) -> (Vec<PerformanceStage>, Vec<PerformanceCounter>, Option<f64>) {
        let stages = self
            .samples
            .iter_mut()
            .filter_map(|(name, samples)| {
                while samples
                    .front()
                    .is_some_and(|(time, _)| at.saturating_duration_since(*time) > WINDOW)
                {
                    samples.pop_front();
                }
                if samples.is_empty() {
                    return None;
                }
                let mut values: Vec<_> = samples.iter().map(|(_, value)| *value).collect();
                values.sort_by(f64::total_cmp);
                let percentile = |p: f64| {
                    values[((values.len() as f64 * p).ceil() as usize)
                        .saturating_sub(1)
                        .min(values.len() - 1)]
                };
                Some(PerformanceStage {
                    name: name.to_string(),
                    samples: values.len() as u32,
                    p50: percentile(0.5),
                    p95: percentile(0.95),
                    max: *values.last().unwrap(),
                })
            })
            .collect();
        let counts = self
            .counts
            .iter()
            .map(|(name, value)| PerformanceCounter {
                name: name.to_string(),
                value: *value,
            })
            .collect();
        let rtt = self
            .rtts
            .get(&session)
            .filter(|(time, _)| at.saturating_duration_since(*time) <= WINDOW)
            .map(|(_, value)| *value);
        (stages, counts, rtt)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_percentiles_expire_without_consuming_other_readers() {
        let mut recorder = Recorder::default();
        let at = Instant::now();
        for value in 0..1000 {
            recorder.observe("encode", f64::from(value), at);
        }
        recorder.observe("encode", f64::NAN, at);
        let (first, _, _) = recorder.snapshot(1, at);
        assert_eq!(first[0].samples, 256);
        assert_eq!(first[0].max, 999.0);
        assert_eq!(first[0].p50, 871.0);
        assert_eq!(recorder.snapshot(2, at).0, first);
        assert!(
            recorder
                .snapshot(1, at + Duration::from_secs(3))
                .0
                .is_empty()
        );
    }
    #[test]
    fn diagnostic_queries_are_bounded_and_throttled_per_session() {
        let mut recorder = Recorder::default();
        let now = Instant::now();
        assert!(recorder.admit_query(1, now));
        assert!(!recorder.admit_query(1, now + Duration::from_millis(100)));
        assert!(recorder.admit_query(2, now));
        assert!(recorder.admit_query(1, now + Duration::from_millis(500)));
        for session in 3..=64 {
            assert!(recorder.admit_query(session, now));
        }
        assert!(!recorder.admit_query(65, now));
    }
    #[test]
    fn rtt_is_per_session_and_expires() {
        let mut recorder = Recorder::default();
        let at = Instant::now();
        recorder.rtts.insert(1, (at, 20.0));
        assert_eq!(recorder.snapshot(1, at).2, Some(20.0));
        assert_eq!(recorder.snapshot(2, at).2, None);
        assert_eq!(recorder.snapshot(1, at + Duration::from_secs(3)).2, None);
    }
}
