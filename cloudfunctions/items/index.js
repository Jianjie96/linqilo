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
        return await getItems(openid)
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

// 获取所有物品
async function getItems(openid) {
  const res = await db.collection(COLLECTION)
    .where({ _openid: openid })
    .orderBy('expiryDate', 'asc')
    .limit(500)
    .get()

  return { code: 0, data: res.data || [] }
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
