/**
 * One-off: give existing completed twin learner sessions a twin report (they were processed with the
 * roleplay report before twin processing existed). Calibrations are skipped. Sequential on purpose.
 *
 *   bun scripts/process-twin-sessions.ts           # only sessions without a twin report
 *   bun scripts/process-twin-sessions.ts --all     # regenerate every twin report
 */
import { db } from "@/lib/db";
import { generateTwinReport, isTwinReport } from "@/lib/twin/session-report";

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
  const report = await generateTwinReport(id);
  if (report) done += 1;
  console.log(report ? `ok      ${id}  topics=${JSON.stringify(report.topics)}  questions=${report.questions.length}` : `failed  ${id}`);
}
console.log(`${done}/${todo.length} processed`);
await db.$disconnect();
