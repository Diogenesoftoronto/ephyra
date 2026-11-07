import type { ReactNode } from "react";
import { Button, Card, Skeleton } from "../kit.ts";
import type { AsyncState } from "../app/useAsync.ts";
import { describeError } from "../lib/errors.ts";

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const d = describeError(error);
  return (
    <Card tone="alert" title={d.title}>
      <p role="alert">{d.body}</p>
      {onRetry && <Button size="sm" onClick={onRetry}>Try again</Button>}
    </Card>
  );
}

/** Loading skeleton, error card, or the loaded data. Old data stays visible while refreshing. */
export function Load<T>({ state, retry, children, skeleton }: {
  state: AsyncState<T>; retry?: () => void; children: (data: T) => ReactNode; skeleton?: ReactNode;
}) {
  if (state.status === "loading") return <>{skeleton ?? <Skeleton lines={4} />}</>;
  if (state.status === "error") return <ErrorState error={state.error} onRetry={retry} />;
  return <>{children(state.data)}</>;
}
