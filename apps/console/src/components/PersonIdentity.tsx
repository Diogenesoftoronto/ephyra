import { useEffect, useState } from "react";
import { personLabel, type PersonProfile } from "@ephyra/core";
import "./PersonIdentity.css";

/**
 * A person as the Not Organic authority describes them: display name or handle, and the avatar the server proxies.
 * Unknown people get a neutral mark and a human label; the DID is only in the optional technical details.
 */
export function PersonIdentity({
  did, profile, avatarUrl, loading, invitedAs, size = 32, details = true,
}: {
  did: string;
  profile?: PersonProfile | null;
  avatarUrl?: string | null;
  loading?: boolean;
  /** The owner's label for an invitation: shown as a label, never as a verified identity. */
  invitedAs?: string;
  size?: 24 | 32 | 48 | 64;
  details?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const imageUrl = avatarUrl && profile?.checkedAt
    ? `${avatarUrl}${avatarUrl.includes("?") ? "&" : "?"}checked=${encodeURIComponent(profile.checkedAt)}` : avatarUrl;
  useEffect(() => setBroken(false), [did, imageUrl]);
  const verified = profile?.status === "verified";
  const label = loading ? "Loading identity…" : verified ? personLabel(profile) : invitedAs ? invitedAs : "Unverified account";
  const initial = verified ? personLabel(profile).replace(/^@/, "").charAt(0).toUpperCase() : "";
  const showImage = verified && profile?.avatar && avatarUrl && !broken;
  return (
    <span className="person" data-verified={verified ? "" : undefined} data-loading={loading ? "" : undefined}>
      <span className="person-avatar" style={{ width: size, height: size }} aria-hidden="true">
        {showImage ? <img src={imageUrl!} alt="" width={size} height={size} loading="lazy" onError={() => setBroken(true)} />
          : <span className="person-avatar__mark">{initial || "·"}</span>}
      </span>
      <span className="person-text">
        <span className="person-name">{label}</span>
        <span className="person-sub">
          {loading ? "Checking Not Organic" : verified
            ? (profile?.displayName && profile.handle ? `@${profile.handle} · verified by Not Organic` : "Verified by Not Organic")
            : invitedAs ? "Invitation label · identity not verified" : "Not Organic did not confirm this identity"}
        </span>
        {details && !loading && (
          <details className="person-details">
            <summary>Technical details</summary>
            <code>{did}</code>
          </details>
        )}
      </span>
    </span>
  );
}
