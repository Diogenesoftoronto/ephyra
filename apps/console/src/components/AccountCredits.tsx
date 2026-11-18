import { useEffect, useState } from "react";
import type { AccountApi, AccountWallet } from "../account-api.ts";

/** Personal account credit; failures remain unavailable rather than appearing as a zero balance. */
export function AccountCredits({ api }: { api: AccountApi }) {
  const [wallet, setWallet] = useState<AccountWallet | null>(null);
  const [status, setStatus] = useState("Checking your Not Organic credit…");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    setWallet(null);
    setStatus("Checking your Not Organic credit…");
    if (!api.wallet) { setStatus("Credit balance is unavailable in this workspace."); return; }
    void api.wallet().then((value) => { if (current) { setWallet(value); setStatus(""); } })
      .catch(() => { if (current) setStatus("Your credit balance could not be checked. Refresh or open your Not Organic account."); });
    return () => { current = false; };
  }, [api, revision]);
  return <section className="settings-subsection" aria-label="AI credits and paid plans">
    <h3>AI credits and paid plans</h3>
    <p>Confirm your email in Not Organic to unlock your one-time Ephyra welcome credit.</p>
    {wallet ? (
      <p>
        Available for Ephyra:{" "}
        <strong>{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(wallet.availableMicros / 1_000_000)}</strong>
      </p>
    ) : <p role="status">{status}</p>}
    {wallet?.welcomeCredit?.awaitingEmailConfirmation && <p>Welcome credit is waiting for email confirmation.</p>}
    {(wallet?.hostedInferenceBlocked || (wallet?.debtMicros ?? 0) > 0) && <p>AI use is paused while your account has an outstanding amount.</p>}
    <div className="account-actions"><button className="ui-button" type="button" onClick={() => setRevision(value => value + 1)}>Refresh credit</button><a className="ui-button" href="https://id.notorganic.info/">Manage Not Organic account</a></div>
    <p>Additional credits and paid plans are on the waitlist. Joining takes no payment and starts no subscription.</p>
    <div className="account-actions"><a className="ui-button" href="https://id.notorganic.info/waitlist?product=ephyra&intent=credits">Join the credit purchase waitlist</a><a className="ui-button" href="https://id.notorganic.info/waitlist?product=ephyra&intent=subscription">Join the paid plan waitlist</a></div>
  </section>;
}
