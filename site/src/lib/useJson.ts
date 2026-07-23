import { useEffect, useState } from "react";
import type { Envelope } from "./types";

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; envelope: Envelope<T> };

/**
 * Fetches one of the JSON files the ETL exports to public/data/. Every
 * fetch is cache-busted with the current hour so the site never serves a
 * stale copy from the browser cache between hourly ETL refreshes without
 * also never re-fetching within the same hour unnecessarily.
 */
export function useJson<T>(fileName: string): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });

  useEffect(() => {
    const cacheBust = new Date().toISOString().slice(0, 13); // hour bucket
    const url = `${import.meta.env.BASE_URL}data/${fileName}?h=${cacheBust}`;

    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.json() as Promise<Envelope<T>>;
      })
      .then((envelope) => setState({ status: "ready", envelope }))
      .catch((err: Error) => setState({ status: "error", error: err.message }));
  }, [fileName]);

  return state;
}
