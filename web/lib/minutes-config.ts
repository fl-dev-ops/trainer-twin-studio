/** Practice-minutes settings, safe to import in the browser (lib/minutes.ts has the ledger). */

/** What a learner gets when they are first invited or assigned. */
export const DEFAULT_LEARNER_MINUTES = 30;
/** shortcut: soft cap on the minutes one learner can be given in total (grants minus take-backs); raise when asked. */
export const MAX_LEARNER_MINUTES = 360;
/** A learner is "low on credits" below this many minutes (the studio flags them). */
export const LOW_LEARNER_MINUTES = 10;
/** A call starts only with at least this many minutes (the learner's, or the org's for admin/team calls): fewer would
 *  be cut off almost at once. A call already running and resumed isn't checked again. */
export const MIN_START_MINUTES = 5;
/** Maximum duration and org-credit reservation per billed admin/team voice call, including calibration. */
export const MAX_STUDIO_CALL_MINUTES = 30;
/** A new org's free trial credits (onboarding, workflows/onboard-org.ts), and how long they last. */
export const TRIAL_MINUTES = 30;
export const TRIAL_DAYS = 30;
