// 物品管理云函数
// action: get | add | update | delete

const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const COLLECTION = 'items'

exports.main = async (event, context) => {
  const { action } = event
  const openid = cloud.getWXContext().OPENID

  try {
    switch (action) {
      case 'get':
        return await getItems(openid, event.skip || 0, event.limit || 100)
      case 'stats':
        return await getStats(openid)
      case 'add':
        return await addItem(openid, event.item)
      case 'update':
        return await updateItem(openid, event.itemId, event.updates)
      case 'delete':
        return await deleteItem(openid, event.itemId)
      default:
        return { code: -1, msg: '未知操作: ' + action }
    }
  } catch (err) {
    console.error(`[${action}] 失败:`, err)
    return { code: -1, msg: err.message }
  }
}

// 分页获取物品（按到期日期升序，配合 createdAt 保证分页稳定）
async function getItems(openid, skip = 0, limit = 100) {
  const where = { _openid: openid }

  const [countRes, listRes] = await Promise.all([
    db.collection(COLLECTION).where(where).count(),
    db.collection(COLLECTION)
      .where(where)
      .orderBy('expiryDate', 'asc')
      .orderBy('createdAt', 'asc')
      .skip(skip)
      .limit(limit)
      .get()
  ])

  return {
    code: 0,
    data: listRes.data || [],
    total: countRes.total,
    skip,
    limit
  }
}

// 与前端 utils/util.js 保持一致的剩余天数计算
function calcDaysRemaining(expiryDate) {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const expiry = new Date(expiryDate)
  expiry.setHours(0, 0, 0, 0)
  return Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
}

// 全量统计摘要（安全/临期/已过期/已省钱计数与价值），供首页统计栏使用
async function getStats(openid) {
  const stats = {
    safe: 0,
    warning: 0,
    expired: 0,
    savedCount: 0,
    savedValue: 0,
    totalValue: 0
  }

  const pageSize = 1000
  let skip = 0

  // 循环拉取精简字段（个人物品数量有限，通常 1 次拉完）
  while (true) {
    const res = await db.collection(COLLECTION)
      .where({ _openid: openid })
      .field({ expiryDate: true, alertDays: true, saved: true, value: true })
      .skip(skip)
      .limit(pageSize)
      .get()

    for (const doc of res.data) {
      const value = parseFloat(doc.value) || 0
      stats.totalValue += value

      if (doc.saved) {
        stats.savedCount += 1
        stats.savedValue += value
        continue
      }

      const days = calcDaysRemaining(doc.expiryDate)
      const alertDays = doc.alertDays || 1
      if (days < 0) {
        stats.expired += 1
      } else if (days <= alertDays) {
        // danger（今日到期）并入 warning 统计，与前端一致
        stats.warning += 1
      } else {
        stats.safe += 1
      }
    }

    if (res.data.length < pageSize) break
    skip += pageSize
  }

  return { code: 0, data: stats }
}

// 添加物品
async function addItem(openid, item) {
  const data = {
    _openid: openid,
    id: item.id,
    name: item.name,
    expiryDate: item.expiryDate,
    productionDate: item.productionDate || '',
    alertDays: item.alertDays || 1,
    category: item.category || '',
    value: parseFloat(item.value) || 0,
    saved: item.saved || false,
    savedAt: item.savedAt || '',
    createdAt: item.createdAt || new Date().toISOString()
  }

  const res = await db.collection(COLLECTION).add({ data })
  return { code: 0, data: { _id: res._id, ...item } }
}

// 更新物品
async function updateItem(openid, itemId, updates) {
  const existing = await db.collection(COLLECTION)
    .where({ _openid: openid, id: itemId })
    .get()

  if (existing.data.length === 0) {
    return { code: -1, msg: '物品不存在' }
  }

  await db.collection(COLLECTION)
    .doc(existing.data[0]._id)
    .update({ data: updates })

  return { code: 0 }
}

// 删除物品
async function deleteItem(openid, itemId) {
  const existing = await db.collection(COLLECTION)
    .where({ _openid: openid, id: itemId })
    .get()

  if (existing.data.length === 0) {
    return { code: -1, msg: '物品不存在' }
  }

  await db.collection(COLLECTION).doc(existing.data[0]._id).remove()
  return { code: 0 }
}
