import pytest
import asyncio
from pathlib import Path
from backend.app.settings import settings
from backend.app.repositories import db

@pytest.mark.asyncio
async def test_watchlist_db_crud(tmp_path):
    settings.DB_PATH = tmp_path / "test_stock.db"
    await db.init_db()
    
    # 初始化後應有預設種子資料
    groups = await db.get_all_groups()
    assert len(groups) >= 3
    treasure_group = next(g for g in groups if g.name == "尋找寶物")
    assert len(treasure_group.items) == 10
    
    # 建立新群組
    new_group = await db.create_group("我的測試群組")
    assert new_group.name == "我的測試群組"
    
    # 新增股票
    item = await db.add_item_to_group(new_group.id, "2330", "台積電", "TSE", "STOCK")
    assert item.code == "2330"
    
    # 重新排序
    await db.add_item_to_group(new_group.id, "2454", "聯發科", "TSE", "STOCK")
    await db.reorder_items(new_group.id, ["2454", "2330"])
    
    groups_after = await db.get_all_groups()
    target = next(g for g in groups_after if g.id == new_group.id)
    assert [i.code for i in target.items] == ["2454", "2330"]
    
    # 刪除項目
    await db.remove_item_from_group(new_group.id, "2454")
    groups_after2 = await db.get_all_groups()
    target2 = next(g for g in groups_after2 if g.id == new_group.id)
    assert len(target2.items) == 1
    
    # 刪除群組
    await db.delete_group(new_group.id)
    groups_final = await db.get_all_groups()
    assert all(g.id != new_group.id for g in groups_final)
