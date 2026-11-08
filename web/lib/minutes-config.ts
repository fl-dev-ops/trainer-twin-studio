/** Practice-minutes settings, safe to import in the browser (lib/minutes.ts has the ledger). */

/** What a learner gets when they are first invited or assigned. */
export const DEFAULT_LEARNER_MINUTES = 30;
/** shortcut: soft cap on the minutes one learner can be given in total (grants minus take-backs); raise when asked. */
export const MAX_LEARNER_MINUTES = 360;
/** A learner is "low on credits" below this many minutes (the studio flags them). */
export const LOW_LEARNER_MINUTES = 10;
