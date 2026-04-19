"""
US stock universe: S&P 500 (via Wikipedia) + NASDAQ 100 + additional large/mid caps.
Falls back to a hardcoded list if Wikipedia is unreachable.
"""
import requests

# NASDAQ 100 tickers (as of 2024)
NASDAQ_100 = [
    "AAPL","MSFT","NVDA","AMZN","META","GOOGL","GOOG","TSLA","AVGO","COST",
    "NFLX","TMUS","ASML","AMD","PEP","LIN","ADBE","QCOM","CSCO","INTU",
    "TXN","AMGN","CMCSA","HON","ISRG","VRTX","LRCX","BKNG","REGN","MU",
    "KLAC","MRVL","PANW","MDLZ","ADP","AMAT","SNPS","CDNS","GILD","ABNB",
    "MELI","FTNT","CSX","CTAS","ADI","PAYX","DXCM","CHTR","ROST","KDP",
    "ORLY","MNST","NXPI","FAST","ODFL","EA","VRSK","CPRT","BIIB","KHC",
    "FANG","CTSH","TEAM","ZS","DDOG","TTD","SGEN","CRWD","PCAR","DLTR",
    "WBD","ILMN","WBA","MRNA","PDD","CEG","ON","GEHC","GFS","IDXX",
    "APP","PLTR","SMCI","ARM","DASH","COIN","WDAY","SNOW","OKTA","ZM",
    "DOCU","UBER","LYFT","ABNB","NET","RBLX","U","RIVN","LCID","SIRI",
]

# Additional large/mid cap US stocks across sectors
ADDITIONAL = [
    # Financials
    "JPM","BAC","WFC","GS","MS","C","AXP","BLK","SCHW","USB",
    "PNC","TFC","COF","AIG","PRU","MET","AFL","ALL","TRV","CB",
    # Healthcare
    "JNJ","UNH","PFE","ABBV","LLY","MRK","TMO","ABT","DHR","BSX",
    "SYK","MDT","EW","DXCM","HOLX","BAX","BDX","ZBH","IQV","CRL",
    # Energy
    "XOM","CVX","COP","EOG","SLB","PSX","MPC","VLO","OXY","HAL",
    "PXD","DVN","HES","BKR","FANG","APA","MRO","CTRA","SM","CLR",
    # Consumer
    "WMT","HD","MCD","SBUX","NKE","TGT","LOW","TJX","BURL","FIVE",
    "DG","DLTR","KR","SFM","ULTA","BBY","GPS","ANF","AEO","PVH",
    # Industrials
    "BA","CAT","DE","HON","UPS","FDX","LMT","RTX","GD","NOC",
    "EMR","ETN","PH","ROK","GE","ITW","MMM","AOS","MAS","IR",
    # Technology
    "IBM","ORCL","CRM","NOW","SNOW","PLTR","ACN","CTSH","DXC","HPQ",
    "HPE","DELL","NTAP","PSTG","WDC","STX","KEYS","TRMB","CDNS","ANSS",
    # Real Estate
    "AMT","PLD","CCI","EQIX","PSA","EXR","WELL","VTR","O","VICI",
    "SPG","MAC","CBL","KIM","REG","EQR","AVB","UDR","CPT","ESS",
    # Utilities
    "NEE","DUK","SO","D","EXC","AEP","XEL","SRE","PCG","ED",
    "WEC","ES","ETR","AEE","CMS","DTE","NI","LNT","EVRG","POR",
    # Materials
    "LIN","APD","SHW","ECL","NEM","FCX","NUE","STLD","CLF","AA",
    "ALB","MP","CTVA","FMC","MOS","CF","ICL","AXTA","RPM","HXL",
    # Communications
    "T","VZ","CMCSA","NFLX","DIS","PARA","WBD","FOX","FOXA","NYT",
    "IPG","OMC","TTWO","EA","ATVI","ROBLX","MTCH","BMBL","SNAP","PINS",
    # Mid-caps
    "SQ","PYPL","AFRM","SOFI","LC","UPST","OPEN","Z","RDFN","COMP",
    "HIMS","RH","W","ETSY","OSTK","CVNA","KMX","AN","LAD","PAG",
    "SPCE","JOBY","ACHR","EVX","ENVX","WOLF","LAZR","MVIS","OUST","LIDR",
]

def get_sp500_tickers():
    """Fetch S&P 500 tickers from Wikipedia."""
    try:
        url = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
        tables = requests.get(url, timeout=10).text
        import re
        tickers = re.findall(r'<td><a href="/wiki/[^"]*" title="[^"]*">([A-Z.]{1,5})</a></td>', tables)
        # Clean up BRK.B style tickers to BRK-B (Yahoo Finance format)
        cleaned = [t.replace(".", "-") for t in tickers if len(t) <= 5]
        return list(set(cleaned))
    except Exception:
        return []

# Hardcoded S&P 500 subset as fallback
SP500_FALLBACK = [
    "MMM","AOS","ABT","ABBV","ACN","ADBE","AMD","AES","AFL","A","APD","ABNB",
    "AKAM","ALB","ARE","ALGN","ALLE","LNT","ALL","GOOGL","GOOG","MO","AMZN",
    "AMCR","AEE","AAL","AEP","AXP","AIG","AMT","AWK","AMP","AME","AMGN",
    "APH","ADI","ANSS","AON","APA","AAPL","AMAT","APTV","ACGL","ADM","ANET",
    "AJG","AIZ","T","ATO","ADSK","AZO","AVB","AVY","AXON","BKR","BALL","BAC",
    "BBWI","BAX","BDX","BRK-B","BBY","BIO","TECH","BIIB","BLK","BK","BA",
    "BKNG","BWA","BXP","BSX","BMY","AVGO","BR","BF-B","BLDR","BG","CDNS",
    "CZR","CPT","CPB","COF","CAH","KMX","CCL","CARR","CTLT","CAT","CBOE",
    "CBRE","CDW","CE","COR","CNC","CNX","CDAY","CF","CRL","SCHW","CHTR",
    "CVX","CMG","CB","CHD","CI","CINF","CTAS","CSCO","C","CFG","CLX",
    "CME","CMS","KO","CTSH","CL","CMCSA","CAG","COP","ED","STZ","CEG",
    "COO","CPRT","GLW","CTVA","CSGP","COST","CTRA","CCI","CSX","CMI","CVS",
    "DHI","DHR","DRI","DVA","DE","DAL","XRAY","DVN","DXCM","FANG","DLR",
    "DFS","DG","DLTR","D","DPZ","DOV","DOW","DTE","DUK","DD","EMN","ETN",
    "EBAY","ECL","EIX","EW","EA","ELV","EMR","ENPH","ETR","EOG","EPAM",
    "EQT","EFX","EQIX","EQR","ESS","EL","ETSY","EG","EVRG","ES","EXC",
    "EXPE","EXPD","EXR","XOM","FFIV","FDS","FICO","FAST","FRT","FDX",
    "FITB","FSLR","FE","FIS","FI","FLT","FMC","F","FTNT","FTV","FOXA",
    "FOX","BEN","FCX","GRMN","IT","GEHC","GEN","GNRC","GD","GE","GIS",
    "GM","GPC","GILD","GPN","GL","GS","HAL","HIG","HAS","HCA","PEAK",
    "HSIC","HSY","HES","HPE","HLT","HOLX","HD","HON","HRL","HST","HWM",
    "HPQ","HUBB","HUM","HII","IBM","IEX","IDXX","ITW","ILMN","INCY","IR",
    "PODD","INTC","ICE","IFF","IP","IPG","INTU","ISRG","IVZ","INVH","IQV",
    "IRM","JBHT","JKHY","J","JCI","JPST","JPM","JNPR","K","KVUE","KDP",
    "KEY","KEYS","KMB","KIM","KMI","KLAC","KHC","KR","LHX","LH","LRCX",
    "LW","LVS","LDOS","LEN","LIN","LYV","LKQ","LMT","L","LOW","LULU",
    "LYB","MTB","MRO","MPC","MKTX","MAR","MMC","MLM","MAS","MA","MTCH",
    "MKC","MCD","MCK","MDT","MRK","META","MET","MTD","MGM","MCHP","MU",
    "MSFT","MAA","MRNA","MHK","MOH","TAP","MDLZ","MPWR","MNST","MCO",
    "MS","MOS","MSI","MSCI","NDAQ","NTAP","NOV","NWSA","NWS","NEE","NKE",
    "NEM","NFLX","NWL","NRG","NUE","NVDA","NVR","NXPI","ORLY","OXY",
    "ODFL","OMC","ON","OKE","ORCL","OGN","OTIS","PCAR","PKG","PANW",
    "PH","PAYX","PAYC","PYPL","PNR","PEP","PFE","PCG","PM","PSX","PNW",
    "PXD","PNC","POOL","PPG","PPL","PFG","PG","PGR","PLD","PRU","PEG",
    "PTC","PSA","PHM","QRVO","PWR","QCOM","DGX","RL","RJF","RTX","O",
    "REG","REGN","RF","RSG","RMD","RVTY","ROK","ROL","ROP","ROST","RCL",
    "SPGI","CRM","SBAC","SLB","STX","SEE","SRE","NOW","SHW","SPG","SWKS",
    "SJM","SNA","SO","LUV","SWK","SBUX","STT","STLD","STE","SYK","SMCI",
    "SYF","SNPS","SYY","TMUS","TROW","TTWO","TPR","TRGP","TGT","TEL",
    "TDY","TFX","TER","TSLA","TXN","TXT","TMO","TJX","TSCO","TT","TDG",
    "TRV","TRMB","TFC","TYL","TSN","USB","UDR","ULTA","UNP","UAL","UPS",
    "URI","UNH","UHS","VLO","VTR","VRSN","VRSK","VZ","VRTX","VLTO","VMC",
    "WRB","GWW","WAB","WBA","WMT","WBD","WM","WAT","WEC","WFC","WELL",
    "WST","WDC","WRK","WY","WHR","WMB","WTW","WYNN","XEL","XYL","YUM",
    "ZBRA","ZBH","ZION","ZTS",
]

def get_all_tickers():
    """Return deduplicated list of all US stock tickers."""
    sp500 = get_sp500_tickers()
    if not sp500:
        sp500 = SP500_FALLBACK

    all_tickers = set(sp500) | set(NASDAQ_100) | set(ADDITIONAL)
    # Remove known problematic tickers
    exclude = {"GOOGL", "BRK.A", "BF.A"}
    all_tickers -= exclude
    return sorted(all_tickers)


if __name__ == "__main__":
    tickers = get_all_tickers()
    print(f"Total tickers: {len(tickers)}")
    print(tickers[:20])
