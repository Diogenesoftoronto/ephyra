import { useId, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { TeamRole } from "@ephyra/core";
import { Button } from "../kit.ts";
import "./InvitationCode.css";

/** Encodes the exact invitation locally. The redeemable URL never goes to an image service. */
export function InvitationCode({ url, role }: { url: string; role: TeamRole }) {
  const mark = useRef<SVGSVGElement>(null);
  const titleId = useId();
  const [error, setError] = useState(false);
  const roleName = role === "approver" ? "Approver" : "Viewer";

  async function save() {
    if (!mark.current) return;
    setError(false);
    const source = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(mark.current)], { type: "image/svg+xml" }));
    try {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 960;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      context.drawImage(image, 0, 0, 960, 960);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
        (value) => value ? resolve(value) : reject(new Error("Image unavailable")), "image/png",
      ));
      const download = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = download;
      link.download = `ephyra-${role}-invitation.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(download), 1000);
    } catch { setError(true); }
    finally { URL.revokeObjectURL(source); }
  }

  return <section className="invitation-code" aria-labelledby={titleId}>
    <div className="invitation-code__mark">
      <QRCodeSVG ref={mark} value={url} size={240} level="M" marginSize={4}
        fgColor="#000000" bgColor="#ffffff" title={`Scan to open this ${roleName} invitation`} role="img" />
    </div>
    <div className="invitation-code__caption">
      <h3 id={titleId}>Scan to join</h3>
      <p>Open your phone’s camera, scan, then sign in to join as a {roleName.toLowerCase()}.</p>
      <Button size="sm" onClick={() => void save()}>Save QR image</Button>
      {error && <p role="status">The image could not be saved. You can still scan it here or copy the invitation link.</p>}
    </div>
  </section>;
}
