/**
 * One-off: give completed twin learner sessions a twin report directly (no workflow; for sessions processed
 * before twin reports existed, or whose report run failed). Calibrations are skipped. Sequential on purpose.
 *
 *   bun scripts/process-twin-sessions.ts           # only sessions without a twin report
 *   bun scripts/process-twin-sessions.ts --all     # regenerate every twin report
 */
import { db } from "@/lib/db";
import { buildTwinReport, isTwinReport, loadTwinReportInput, markTwinReportFailed, saveTwinReport } from "@/lib/twin/session-report";

const all = process.argv.includes("--all");
const sessions = await db.interviewSession.findMany({
  where: { status: "completed", deletedAt: null, agent: { kind: "TWIN" }, twinCalibration: { is: null } },
  orderBy: { createdAt: "asc" },
  select: { id: true, report: true },
});
const todo = all ? sessions : sessions.filter((row) => !isTwinReport(row.report));
console.log(`${todo.length} of ${sessions.length} completed twin sessions to process`);

let done = 0;
for (const { id } of todo) {
  await db.interviewSession.update({ where: { id }, data: { reportStatus: "generating" } });
  try {
    const report = await buildTwinReport(id, await loadTwinReportInput(id));
    await saveTwinReport(id, report);
    done += 1;
    console.log(`ok      ${id}  topics=${JSON.stringify(report.topics)}  questions=${report.questions.length}`);
  } catch (error) {
    await markTwinReportFailed(id);
    console.log(`failed  ${id}  ${error instanceof Error ? error.message : error}`);
  }
}
console.log(`${done}/${todo.length} processed`);
await db.$disconnect();
