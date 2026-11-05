// A fixed list of broad ETFs for the Swing Lab's "ETFs" stock list: US sectors and industries, countries, bonds, commodities.
// ETFs are not added to or dropped from an index after a rally, so this list has far less hindsight than today's S&P 500 members.
// SPY is left out on purpose: it is the benchmark everything is compared with. Funds that did not exist for the whole window
// are simply ranked once they have enough history.
const GROUPS = {
  "US sector": "XLK XLF XLE XLV XLY XLP XLI XLB XLU XLRE XLC",
  "US industry": "SMH XBI IBB KRE ITB XHB XOP XME ITA IGV IYT XRT KBE IHI",
  "US size and style": "QQQ IWM MDY IJR IWD IWF MTUM QUAL USMV",
  "Country": "EWJ EWG EWU EWZ EWY EWT EWA EWC EWH EWW EWS EWP EWI EWL INDA FXI EZA TUR",
  "Region": "EFA EEM VGK VPL",
  "Bonds": "TLT IEF SHY LQD HYG TIP AGG",
  "Commodities and real assets": "GLD SLV USO DBC UNG VNQ",
};
export const ETF_UNIVERSE = Object.entries(GROUPS).flatMap(([sector, list]) => list.split(" ").map((symbol) => ({ symbol, company: symbol, sector })));
