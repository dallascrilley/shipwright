import { defineEventHandler } from "h3";

/** Liveness: process is up. Dependencies are checked by /readyz instead. */
export default defineEventHandler(() => ({ ok: true }));
