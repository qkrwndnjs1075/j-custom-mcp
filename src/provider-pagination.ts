import { load } from "cheerio";
import { z } from "zod";
import { PassengersSchema } from "./passengers";
import type { TripSearch } from "./provider";
import { ProviderError, parseProviderValue } from "./provider-types";

const formSchema = z
  .object({
    depr_Trml_Cd: z.string().min(1),
    arvl_Trml_Cd: z.string().min(1),
    depr_Trml_Nm: z.string().min(1),
    arvl_Trml_Nm: z.string().min(1),
    depr_Dt: z.string().regex(/^\d{8}$/),
    depr_Time: z.string().regex(/^\d{6}$/),
    ig: z.string().regex(/^\d+$/),
    im: z.string().regex(/^\d+$/),
    ic: z.string().regex(/^\d+$/),
    bef_Aft_Dvs: z.literal("D"),
    req_Rec_Num: z.literal("10"),
  })
  .strict();
const cursorSchema = z
  .object({
    query: z
      .object({
        service: z.literal("intercity"),
        departureId: z.string(),
        arrivalId: z.string(),
        date: z.string(),
        time: z.string(),
        passengers: PassengersSchema,
      })
      .strict(),
    form: formSchema,
  })
  .strict();

function criteria(search: TripSearch) {
  return {
    service: search.service,
    departureId: search.departureId,
    arrivalId: search.arrivalId,
    date: search.date.replaceAll("-", ""),
    time: search.time,
    passengers: search.passengers,
  };
}

export function readContinuation(search: TripSearch): URLSearchParams | null {
  if (search.continuation === undefined) return null;
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(search.continuation)) {
    throw new ProviderError("layout", "Invalid provider continuation");
  }
  let input: unknown;
  try {
    input = JSON.parse(Buffer.from(search.continuation, "base64url").toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new ProviderError("layout", "Invalid provider continuation", { cause: error });
    throw error;
  }
  const cursor = parseProviderValue(cursorSchema, input);
  if (
    JSON.stringify(cursor.query) !== JSON.stringify(criteria(search)) ||
    cursor.form.depr_Trml_Cd !== search.departureId ||
    cursor.form.arvl_Trml_Cd !== search.arrivalId ||
    cursor.form.depr_Dt !== search.date.replaceAll("-", "") ||
    cursor.form.ig !== String(search.passengers.adults) ||
    cursor.form.im !== String(search.passengers.students) ||
    cursor.form.ic !== String(search.passengers.children)
  ) {
    throw new ProviderError("layout", "Continuation does not belong to this journey query");
  }
  return new URLSearchParams(cursor.form);
}

export function nextContinuation(html: string, search: TripSearch): string | null {
  const $ = load(html);
  const links = $(".paging a.next");
  if (links.length === 0) return null;
  const match = links
    .attr("onclick")
    ?.match(/^dwnPage\('D','10','(\d{8})','(\d{6})'\);\s*return false;\s*$/);
  if (links.length !== 1 || !match?.[1] || !match[2]) {
    throw new ProviderError("layout", "Unrecognized provider next-page action");
  }
  if (match[1] !== search.date.replaceAll("-", "")) return null;
  const fields = new Map(
    $("form#onewayInfo input[name]")
      .toArray()
      .map((input) => [$(input).attr("name"), $(input).attr("value")] as const),
  );
  const form = parseProviderValue(formSchema, {
    depr_Trml_Cd: fields.get("depr_Trml_Cd"),
    arvl_Trml_Cd: fields.get("arvl_Trml_Cd"),
    depr_Trml_Nm: fields.get("depr_Trml_Nm"),
    arvl_Trml_Nm: fields.get("arvl_Trml_Nm"),
    depr_Dt: match[1],
    depr_Time: match[2],
    ig: fields.get("ig"),
    im: fields.get("im"),
    ic: fields.get("ic"),
    bef_Aft_Dvs: "D",
    req_Rec_Num: "10",
  });
  if (
    form.depr_Trml_Cd !== search.departureId ||
    form.arvl_Trml_Cd !== search.arrivalId ||
    form.ig !== String(search.passengers.adults) ||
    form.im !== String(search.passengers.students) ||
    form.ic !== String(search.passengers.children)
  ) {
    throw new ProviderError("layout", "Provider pagination changed the journey");
  }
  return Buffer.from(JSON.stringify({ query: criteria(search), form })).toString("base64url");
}
