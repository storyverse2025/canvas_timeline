// AEGIS adaptation-landscape persistence (HarnessX §4.3 Planner input).
//
// evolution/state.json shape:
// {
//   iterations: [{ iter, ts, digest, editIntents, candidates: [{id, verdict, ...}], shipped }],
//   attemptedEdits: [{ targetFile, editType, iter, outcome, rationale }],
//   componentFailureHistory: { [componentPath]: [{ iter, caseId, failureCategory }] }
// }

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export function statePath(cwd = process.cwd()) {
  return join(cwd, 'evolution', 'state.json')
}

export function loadState(cwd = process.cwd()) {
  const p = statePath(cwd)
  if (!existsSync(p)) {
    return { iterations: [], attemptedEdits: [], componentFailureHistory: {} }
  }
  return JSON.parse(readFileSync(p, 'utf8'))
}

export function saveState(state, cwd = process.cwd()) {
  writeFileSync(statePath(cwd), JSON.stringify(state, null, 1), 'utf8')
}

export function recordIteration(state, entry) {
  state.iterations.push(entry)
  return state
}

export function recordAttemptedEdit(state, edit) {
  state.attemptedEdits.push(edit)
  return state
}

export function recordFailures(state, componentPath, records) {
  const list = state.componentFailureHistory[componentPath] ?? []
  state.componentFailureHistory[componentPath] = [...list, ...records]
  return state
}

/** Component paths never yet targeted by an edit — feeds the Planner's
 *  under-exploration defense (untried edit types should rank higher). */
export function untriedComponents(state) {
  const tried = new Set(state.attemptedEdits.map((e) => e.targetFile))
  return Object.keys(state.componentFailureHistory).filter((c) => !tried.has(c))
}
