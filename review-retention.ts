#!/usr/bin/env bun
import { runReviewRetentionMain } from "./src/cli/review-retention.js";

process.exitCode = await runReviewRetentionMain();
