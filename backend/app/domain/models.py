from typing import Optional, Literal
from pydantic import BaseModel, Field

DataStatus = Literal['live', 'stale', 'initializing', 'closed', 'error']

class QuoteState(BaseModel):
    code: str
    name: str = ""
    exchange: str = "TSE"
    securityType: str = "STOCK"
    last: Optional[float] = None
    oddLotLast: Optional[float] = None
    bid: Optional[float] = None
    ask: Optional[float] = None
    open: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None
    totalVolume: Optional[int] = None
    previousClose: Optional[float] = None
    change: Optional[float] = None
    changePercent: Optional[float] = None
    sourceTs: Optional[str] = None
    oddLotSourceTs: Optional[str] = None
    receivedAt: str = ""
    dataStatus: DataStatus = "initializing"
    revision: int = 0
    isSimulated: bool = False
    isAttention: bool = False
    dispositionLevel: int = 0
    dispositionPeriod: Optional[str] = None

class MarketIndexQuote(BaseModel):
    code: str
    name: str
    price: Optional[float] = None
    change: Optional[float] = None
    changePercent: Optional[float] = None
    reference: Optional[float] = None
    open: Optional[float] = None
    high: Optional[float] = None
    low: Optional[float] = None
    volumeText: Optional[str] = None
    volumeAmount: Optional[float] = None

class StockPositionItem(BaseModel):
    code: str
    name: str = ""
    exchange: str = "TSE"
    quantity: float = 0.0
    costPrice: float = 0.0
    initialLast: Optional[float] = None
    initialPnl: Optional[float] = None

class WatchlistItem(BaseModel):
    id: str
    groupId: str
    code: str
    name: str
    exchange: str
    securityType: str
    position: int

class WatchlistGroup(BaseModel):
    id: str
    name: str
    position: int
    createdAt: str
    updatedAt: str
    isSystemGroup: bool = False
    items: list[WatchlistItem] = []

class CreateGroupRequest(BaseModel):
    name: str

class UpdateGroupRequest(BaseModel):
    name: Optional[str] = None
    position: Optional[int] = None

class AddItemRequest(BaseModel):
    code: str

class ReorderItemsRequest(BaseModel):
    codes: list[str]

class InstrumentSearchResult(BaseModel):
    code: str
    name: str
    exchange: str
    securityType: str
    reference: Optional[float] = None
    isAttention: bool = False
    dispositionLevel: int = 0
    dispositionPeriod: Optional[str] = None

class StockAnnouncementItem(BaseModel):
    id: str
    code: str
    tag: str
    title: str
    date: Optional[str] = None
    detail: Optional[str] = None
    category: str
    updatedAt: Optional[str] = None

class CalendarEventItem(BaseModel):
    id: str
    date: str  # YYYY-MM-DD
    time: Optional[str] = None  # e.g. "20:30", "14:00", "02:00"
    type: str  # 'futures' | 'macro' | 'exhibition' | 'stock'
    category: str  # 'tx_settlement' | 'sgx_settlement' | 'quad_witching' | 'fomc' | 'cpi' | 'ppi' | 'nfp' | 'jackson_hole' | 'exhibition' | 'earnings' | 'revenue' | 'exdividend' | 'briefing' | 'macro_other'
    title: str
    tag: str
    code: Optional[str] = None
    name: Optional[str] = None
    detail: Optional[str] = None
    forecast: Optional[str] = None
    previous: Optional[str] = None
    impact: Optional[str] = None  # 'High' | 'Medium' | 'Low'

class CalendarMonthResponse(BaseModel):
    year: int
    month: int
    events: list[CalendarEventItem]
    updatedAt: str

class PlaceOrderRequest(BaseModel):
    code: str
    action: str = "sell"
    quantity: int = 1
    unit: str = "lot"
    price_type: str = "limit"
    price: float = 0.0
    order_lot: Optional[str] = None  # Common, IntradayOdd, Fixing, Odd

class OrderItem(BaseModel):
    id: str
    ordno: str = ""
    code: str
    name: str = ""
    action: str
    price: float
    originalPrice: float
    modifiedPrice: float = 0.0
    priceType: str = "LMT"
    qty: int
    originalQty: int
    dealQty: int = 0
    cancelQty: int = 0
    orderLot: str = "Common"
    status: str
    statusCode: str = ""
    msg: str = ""
    time: str = ""
    canCancel: bool = False
    canUpdatePrice: bool = False
    canUpdateQty: bool = False

class UpdateOrderRequest(BaseModel):
    newPrice: Optional[float] = None
    newQty: Optional[int] = None

class SettlementItem(BaseModel):
    t: int  # 0, 1, 2
    date: str
    amount: float  # 金額 (元, 負數為扣款，正數為入帳)
    amountWan: float  # 金額 (萬)

class SettlementTradeDetail(BaseModel):
    code: str
    name: str = ""
    action: str  # 'Buy' | 'Sell'
    qty: int
    price: float
    totalPrice: float  # 成交總金額 (股數 * 單價)
    fee: int  # 手續費
    tax: int  # 證交稅
    netAmount: float  # 該筆淨交割款 (賣出: + net, 買入: - net)
    netAmountWan: float  # 該筆淨交割款 (萬)

class AccountBalanceState(BaseModel):
    hasConfigured: bool = False  # 使用者是否已手動設定過本金
    baseCapitalWan: Optional[float] = None  # 起始投資本金 (萬)
    capitalMode: str = "after_t0"  # 'before_t0' (T+0扣款前) 或 'after_t0' (T+0扣款後)
    t0Date: str = ""
    t0Amount: float = 0.0  # 今日 T+0 交割金額 (元)
    t0RemainingWan: Optional[float] = None  # 格子 1: T+0 餘額 (萬)
    t1Date: str = ""
    t1Amount: float = 0.0  # 次日 T+1 交割金額 (元)
    t1RemainingWan: Optional[float] = None  # 格子 2: T+1 餘額 (萬)
    t2Date: str = ""
    t2Amount: float = 0.0  # 後天 T+2 交割金額 (元)
    t2RemainingWan: Optional[float] = None  # 格子 3: T+2 最終可用本金 (萬)
    t2Formula: str = ""  # 算式表示法，例如: "+10.83萬(富喬) +1.01萬(今國光) -5.45萬(大毅)"
    t2Details: list[SettlementTradeDetail] = []  # 當日買賣成交明細
    settlements: list[SettlementItem] = []
    updatedAt: str = ""

class UpdateCapitalRequest(BaseModel):
    capitalWan: float
    capitalMode: Optional[str] = "after_t0"

