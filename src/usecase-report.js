/**
 * usecase-report.js
 *
 * Structured reporting helpers for end-to-end usecase runs.
 */

export function createRunReport(meta) {
  return {
    meta: {
      startedAt: new Date().toISOString(),
      ...meta,
    },
    scenarios: [],
    assertions: [],
    recommendations: [],
  };
}

export function startScenario(report, name) {
  const scenario = {
    name,
    startedAt: new Date().toISOString(),
    steps: [],
    assertions: [],
    outputs: {},
  };
  report.scenarios.push(scenario);
  return scenario;
}

export function addStep(scenario, label, status = 'info', details = null) {
  scenario.steps.push({
    at: new Date().toISOString(),
    label,
    status,
    details,
  });
}

export function addAssertion(report, scenario, label, passed) {
  const row = {
    scenario: scenario?.name ?? null,
    label,
    passed: Boolean(passed),
    at: new Date().toISOString(),
  };
  report.assertions.push(row);
  if (scenario) scenario.assertions.push(row);
}

export function finalizeReport(report) {
  const passed = report.assertions.filter(a => a.passed).length;
  const failed = report.assertions.filter(a => !a.passed).length;
  report.meta.finishedAt = new Date().toISOString();
  report.meta.summary = {
    total: report.assertions.length,
    passed,
    failed,
  };
  report.recommendations = buildRecommendations(report);
  return report;
}

export function buildRecommendations(report) {
  const recs = [];
  const failed = report.assertions.filter(a => !a.passed);

  if (failed.length > 0) {
    recs.push({
      severity: 'high',
      category: 'reliability',
      message: 'Add stronger verify gates to workflows where assertions failed.',
      evidence: failed.slice(0, 5).map(f => `${f.scenario ?? 'run'}: ${f.label}`),
    });
  }

  const sparseScenarios = report.scenarios.filter(s => s.steps.length < 3);
  if (sparseScenarios.length > 0) {
    recs.push({
      severity: 'medium',
      category: 'observability',
      message: 'Increase step-level tracing to keep structured output complete.',
      evidence: sparseScenarios.map(s => `${s.name}: ${s.steps.length} step entries`),
    });
  }

  if (report.assertions.length > 0 && failed.length === 0) {
    recs.push({
      severity: 'low',
      category: 'maintenance',
      message: 'Promote repeated setup patterns into shared src runtime modules.',
      evidence: ['All assertions passed; this is a good point to reduce duplicated setup code.'],
    });
  }

  return recs;
}
