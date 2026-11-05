import { context, response as expressResponse, trip } from "../tests/go-express-fixtures";
import { fixture as ticketFixture } from "../tests/go-ticket-fixtures";
import { publicProviderFixture } from "../tests/public-provider-fixture";

export async function createSandboxProvider() {
  const publicProvider = await publicProviderFixture();
  const cancellation = ticketFixture("intercity", (_path, response) =>
    JSON.parse(
      JSON.stringify(response).replaceAll('"bus-member"', JSON.stringify(context.userNumber)),
    ),
  );
  const calls: string[] = [];
  let issued = false;
  const row = trip.row;
  const schedule = `<input name="deprCd" value="${row.terfri}"><input name="arvlCd" value="${row.tertoi}"><input name="deprDtm" value="${row.timdte}">
<p role="row"><span class="start_time">14:20</span><span class="bus_com">Synthetic</span><span class="grade">우등</span><span class="remain">3 석</span>
<a onclick="fnSatsChc('${row.timdte}','142000','140000','${row.terfro}','${row.tertoo}','1','53','0','Y','N','021','393','N','N','N','N');">선택</a></p>`;
  const fields = {
    deprCd: row.terfri,
    arvlCd: row.tertoi,
    deprDtm: row.timdte,
    deprTime: "142000",
    alcnDeprTime: "140000",
    alcnDeprTrmlNo: row.terfro,
    alcnArvlTrmlNo: row.tertoo,
    indVBusClsCd: row.busgrao,
    cacmCd: row.corcodo,
    adltFee: trip.fareQuotes.adults?.unitFareKrw,
    teenFee: trip.fareQuotes.students?.unitFareKrw,
    chldFee: trip.fareQuotes.children?.unitFareKrw,
  };
  const seats =
    Object.entries(fields)
      .map(([name, value]) => `<input name="${name}" value="${value}">`)
      .join("") +
    '<div class="bg_seatBox"><div class="seatList">' +
    [1, 3, 4].map((seat) => `<label><input name="seatBoxDtl" value="${seat}"></label>`).join("") +
    "</div></div>";
  const expressPaths = new Set([
    "selectTimInfo2.do",
    "selectArrInfo.do",
    "insertPcpyNo.do",
    "deletePcpyNo.do",
    "insertTckCad_CR.do",
    "selectTckRstStat.do",
    "selectBuyTckInfo2.do",
    "selectBuyTckInfoList2.do",
    "selectBuyTckListSecu.do",
  ]);
  return {
    calls,
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      calls.push(`${url.hostname}${url.pathname}`);
      const publicResponse = publicProvider(url);
      if (publicResponse) return publicResponse;
      const path = url.pathname.split("/").at(-1) ?? "";
      if (url.hostname === "icbusmob.tmoney.co.kr") return cancellation.transport(request);
      if (url.hostname === "www.kobus.co.kr") {
        switch (url.pathname) {
          case "/mrs/readRotLinInf.ajax":
            return Response.json({
              rotInfList: [
                {
                  deprCd: row.terfri,
                  arvlCd: row.tertoi,
                  deprNm: "센트럴시티(서울)",
                  arvlNm: "서산",
                  deprArea: "서울",
                  arvlArea: "충남",
                  takeTime: "110",
                },
              ],
            });
          case "/mrs/alcnSrch.do":
            return new Response(schedule);
          case "/mrs/satschc.do":
            return new Response(seats);
        }
      }
      if (url.hostname === "tiaapi.tmoney.co.kr") {
        if (path === "uptMbrsAuthTknInfo")
          return Response.json({ rstCd: 200, dta: { authTkn: "synthetic-refreshed" } });
        if (path === "inqrPymMnsListAtPym" || path === "autoReserve")
          return expressResponse(request);
      }
      if (url.hostname === "exp.tmoney.co.kr" && expressPaths.has(path)) {
        if (path === "selectBuyTckListSecu.do" && !issued)
          return Response.json({ errCode: "00000", ticketList: [] });
        if (path === "insertTckCad_CR.do") issued = true;
        return expressResponse(request);
      }
      throw new TypeError(
        "Sandbox blocked an unsupported provider request; no network request was sent",
      );
    },
  };
}
