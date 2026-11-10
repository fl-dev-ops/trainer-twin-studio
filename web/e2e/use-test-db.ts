// Import first in e2e scripts: lib/db connects to the test database, and no email goes out.
import { e2eServerEnv } from "./env";

Object.assign(process.env, e2eServerEnv());
