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
