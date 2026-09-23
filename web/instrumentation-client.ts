import posthog from "posthog-js";

if (process.env.NEXT_PUBLIC_POSTHOG_KEY) {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
    capture_pageview: false, // captured manually on route change (components/posthog/tracker.tsx)
    person_profiles: "identified_only",
    // Session recording is on by default in PostHog Cloud.
  });
}
