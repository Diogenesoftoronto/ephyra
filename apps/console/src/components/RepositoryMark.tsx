import { useState } from "react";
import "./RepositoryMark.css";

export function RepositoryMark({ name, sources = [] }: { name: string; sources?: string[] }) {
  const [failed, setFailed] = useState<string[]>([]);
  const [loaded, setLoaded] = useState<string>();
  const source = sources.find(url => !failed.includes(url));
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? "?";
  return <span className="repository-mark" aria-hidden="true">
    {initial}
    {source && <img key={source} src={source} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer"
      data-loaded={loaded === source ? "" : undefined} onLoad={() => setLoaded(source)}
      onError={() => setFailed(previous => [...previous, source])} />}
  </span>;
}
