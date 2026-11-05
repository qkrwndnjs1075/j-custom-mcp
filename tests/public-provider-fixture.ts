export async function publicProviderFixture() {
  const dispatch = await Bun.file(new URL("./fixtures/dispatch.html", import.meta.url)).text();
  const seats = await Bun.file(new URL("./fixtures/seats.html", import.meta.url)).text();
  return (url: URL): Response | undefined => {
    if (url.hostname !== "txbus.t-money.co.kr") return undefined;
    switch (url.pathname) {
      case "/otck/readTrmlList.do":
        return Response.json([
          { trml_Cd: "0671801", trml_Nm: "Departure", cty_Bus_Area_Nm: "Area" },
          { trml_Cd: "3455101", trml_Nm: "Arrival", cty_Bus_Area_Nm: "Area" },
        ]);
      case "/otck/readAlcnList.do":
        return new Response(dispatch);
      case "/otck/readSatsFee.do":
        return new Response(seats);
      default:
        throw new TypeError("Unexpected public provider operation");
    }
  };
}
