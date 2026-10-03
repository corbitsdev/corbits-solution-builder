const LOCAL_TIME = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });

/** A recorded ISO timestamp in the viewer's own zone, named, so a person and a specialist handed it read the same moment. */
export function localTime(iso: string): string {
  return LOCAL_TIME.format(new Date(iso));
}
