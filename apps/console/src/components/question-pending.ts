export type PendingQuestionAnswer = { id: string; trailId: string; operationKey: string };
export const questionScope = (principal: string, workspace: string) => `ephyra.question.pending:${JSON.stringify([principal, workspace])}:`;
export function pendingQuestionAnswers(scope: string): PendingQuestionAnswer[] {
  const pending: PendingQuestionAnswer[] = [];
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (!key?.startsWith(scope)) continue;
      try {
        const value = JSON.parse(sessionStorage.getItem(key)!);
        if (/^[a-f0-9]{64}$/.test(value.id) && typeof value.trailId === "string" && value.trailId.length <= 500 &&
          typeof value.operationKey === "string" && value.operationKey.length <= 100 && key === `${scope}${value.id}`) pending.push(value);
      } catch { /* An invalid local reference cannot authorize an answer. */ }
    }
  } catch { /* Storage can be unavailable; the mounted form still blocks an uncertain write. */ }
  return pending;
}
export function rememberQuestionAnswer(scope: string, value: PendingQuestionAnswer) {
  try { sessionStorage.setItem(`${scope}${value.id}`, JSON.stringify(value)); } catch { /* Memory only. */ }
}
export function forgetQuestionAnswer(scope: string, id: string) {
  try { sessionStorage.removeItem(`${scope}${id}`); } catch { /* Memory only. */ }
}
