#!/usr/bin/env node
// Guards the step order of the GitHub Actions workflows: `actions/checkout` cleans the workspace by default, so a
// checkout that runs after a step which downloaded or wrote files deletes them. That is how the v0.4.0 release run
// failed (the image publish jobs downloaded the platform digests, then a sparse checkout removed them).
//
//   node scripts/workflow-order.mjs [workflow.yml ...]
//     Checks the given files (default: every file in .github/workflows) and prints each violation; exits 1 on any.
//
// Node built-ins only. The parser reads the layout these workflows use (two-space indents: `jobs:` at column 0, job ids
// at 2, `steps:` at 4, step items at 6); it fails on a job whose steps it cannot find rather than passing silently.
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The jobs of a workflow, each with its steps as raw text blocks, in order. */
export function workflowJobs(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const jobs = [];
  let inJobs = false;
  let job;
  let inSteps = false;
  let step;
  const endStep = () => {
    if (step && job) job.steps.push(step.join('\n'));
    step = undefined;
  };
  for (const line of lines) {
    if (/^\S/.test(line)) {
      endStep();
      inSteps = false;
      inJobs = /^jobs:\s*$/.test(line);
      job = undefined;
      continue;
    }
    if (!inJobs) continue;
    const jobId = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobId) {
      endStep();
      inSteps = false;
      job = { id: jobId[1], steps: [], hasSteps: false, reusable: false };
      jobs.push(job);
      continue;
    }
    if (!job) continue;
    if (/^ {4}\S/.test(line)) {
      endStep();
      inSteps = /^ {4}steps:\s*$/.test(line);
      if (inSteps) job.hasSteps = true;
      if (/^ {4}uses:\s*\S/.test(line)) job.reusable = true;
      continue;
    }
    if (!inSteps) continue;
    if (/^ {6}- /.test(line)) {
      endStep();
      step = [line];
    } else if (step) {
      step.push(line);
    }
  }
  endStep();
  return jobs;
}

const usesOf = (step) => /^\s*(?:- )?uses:\s*([^\s#]+)/m.exec(step)?.[1] ?? '';
const isCheckout = (step) => /^actions\/checkout@/.test(usesOf(step));

/** Why a step leaves files in the workspace that a later checkout would delete, or undefined when it does not. */
export function producesFiles(step) {
  const uses = usesOf(step);
  if (/^actions\/download-artifact@/.test(uses)) return 'downloads artifacts';
  if (/^actions\/(cache|upload-artifact)@/.test(uses)) return;
  const run = /^\s*(?:- )?run:\s*(.*)$/m.exec(step);
  if (!run) return;
  const body = step.slice(run.index);
  // Writes that stay outside the workspace (step outputs, the summary, /dev/null, the runner's temp folder) are fine.
  const writes = body
    .split('\n')
    .flatMap((line) => [...line.matchAll(/(?:^|[^0-9&<>|])>>?\s*("?)([^\s"|;&)]+)\1/g)].map((match) => match[2]))
    .filter(
      (target) => !/^(?:"?\$\{?GITHUB_(?:OUTPUT|STEP_SUMMARY|ENV|PATH)\}?"?|\/dev\/(?:null|stderr|stdout)|&\d|"?\$\{?RUNNER_TEMP\}?.*)$/.test(target),
    );
  if (writes.length) return `writes ${writes.join(', ')}`;
  if (/(?:^|[\s;&|(])(?:mkdir|cp|mv|touch|tee|curl\s[^\n]*-[A-Za-z]*[oO]|wget|tar\s[^\n]*-?x|unzip|gh\s+(?:release|run)\s+download)\b/m.test(body))
    return 'creates files';
}

/** Every checkout that follows a step which produced files in the same job. */
export function checkoutOrderViolations(text, file = 'workflow') {
  const violations = [];
  for (const job of workflowJobs(text)) {
    if (job.reusable) continue;
    if (!job.hasSteps || job.steps.length === 0) {
      violations.push(`${file}: job ${job.id}: no steps found (the order check cannot read this job)`);
      continue;
    }
    let producer;
    job.steps.forEach((step, index) => {
      if (isCheckout(step)) {
        if (producer) {
          violations.push(
            `${file}: job ${job.id}: step ${index + 1} (actions/checkout) runs after step ${producer.index + 1}, which ${producer.reason}; checkout cleans the workspace and would delete them. Move the checkout first.`,
          );
        }
        return;
      }
      const reason = producesFiles(step);
      if (reason && !producer) producer = { index, reason };
    });
  }
  return violations;
}

export function workflowFiles(dir = join(repo, '.github', 'workflows')) {
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => join(dir, name));
}

function main(...files) {
  const targets = files.length ? files.map((file) => resolve(file)) : workflowFiles();
  const violations = targets.flatMap((file) => checkoutOrderViolations(readFileSync(file, 'utf8'), file));
  for (const violation of violations) console.error(violation);
  if (violations.length) process.exit(1);
  console.log(`checkout order: ${targets.length} workflow files checked`);
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked === realpathSync(fileURLToPath(import.meta.url))) main(...process.argv.slice(2));
