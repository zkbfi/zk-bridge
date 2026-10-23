//! Section profiling for the SP1 guests.
//!
//! The SP1 executor reports only one number: the instruction count of the whole run. Its cycle tracker (the
//! `cycle-tracker-report-start` and `cycle-tracker-report-end` lines on standard output) needs the executor feature
//! `profiling`, which pulls extra crates. This module measures a section by difference instead.
//!
//! [`tracked`] wraps a section. In a guest built with the feature `section-profile`, the guest wrapper calls
//! [`repeat_section`] with one label. [`tracked`] then runs the section with that label twice and keeps the second result.
//! The instruction count of the run with the label, minus the count of a run without a label, is the cost of the
//! section, summed over every call of it. In every other build [`tracked`] only runs the closure, so the shipped guests
//! carry no profiling code and their program keys do not depend on it.

#[cfg(feature = "section-profile")]
static REPEATED_LABEL: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Names the section that [`tracked`] runs twice. Only the first call has an effect. An empty label names no section.
#[cfg(feature = "section-profile")]
pub fn repeat_section(label: String) {
    let _ = REPEATED_LABEL.set(label);
}

/// Runs `body` and returns its result. With the feature `section-profile`, it first runs `body` once more when `label`
/// is the label that [`repeat_section`] named.
#[cfg(feature = "section-profile")]
pub fn tracked<T>(label: &str, body: impl Fn() -> T) -> T {
    if REPEATED_LABEL.get().is_some_and(|repeated| repeated == label) {
        let _ = std::hint::black_box(body());
    }
    body()
}

/// Runs `body`. Without the feature `section-profile`, no profiling code exists.
#[cfg(not(feature = "section-profile"))]
#[inline(always)]
pub fn tracked<T>(_label: &str, body: impl Fn() -> T) -> T {
    body()
}
