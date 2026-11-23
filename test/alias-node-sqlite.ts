/**
 * In tests, every `import "node:sqlite"` goes to our stand-in, as wrangler's `alias` does in
 * the Worker, so tests run a2's log store on a `SqlDriver` exactly as the Durable Object does.
 * Our own sql-node driver loads the real module with `process.getBuiltinModule`, which this
 * mock does not touch.
 */
import { mock } from "bun:test"
import * as standIn from "../packages/sql/src/node-sqlite.ts"

mock.module("node:sqlite", () => ({ ...standIn, default: standIn.default }))
