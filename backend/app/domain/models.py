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

