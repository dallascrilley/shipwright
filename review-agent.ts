#!/usr/bin/env bun
import { runReviewMain } from "./src/cli/review-main.js";

process.exitCode = await runReviewMain();
