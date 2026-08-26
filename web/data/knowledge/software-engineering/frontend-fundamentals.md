# Frontend fundamentals reference

JavaScript executes synchronous code on the call stack. Host environments provide asynchronous facilities such as timers and network requests. Completed callbacks wait in queues and can execute only when the stack is available. Promise reactions use the microtask queue, which is drained before the next macrotask; a continuous stream of microtasks can delay other work.

React reconciliation compares element trees and uses type and key identity to decide whether to preserve or replace component instances. A component can re-render because its state changed, its parent rendered, its consumed context changed, or an external subscription updated it. Memoization has comparison, memory, and cognitive overhead and is useful only when avoided work justifies that cost.

API gateway caching can reduce downstream work and latency, but the design must address cache keys, tenant isolation, TTL, invalidation, cache stampedes, stale data, fallback behavior, and hit-rate monitoring. Laboratory measurements and real-user measurements answer different performance questions.
