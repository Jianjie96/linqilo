/**
 * 云数据库操作工具
 * 
 * 所有操作通过云函数调用，Network 面板可见
 * 云函数：items（action: get | add | update | delete）
 */

const COLLECTION_SUBSCRIPTIONS = 'subscriptions'

// --- 通用云函数调用封装 ---

function callCloud(name, data = {}) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name,
      data,
      success: (res) => {
        if (res.result && res.result.code === 0) {
          resolve(res.result)
        } else {
          reject(new Error(res.result?.msg || '云函数调用失败'))
        }
      },
      fail: reject
    })
  })
}

// --- openid ---

function getOpenid() {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name: 'getOpenid',
      success: (res) => resolve(res.result.openid),
      fail: (err) => reject(err)
    })
  })
}

// --- 物品 CRUD ---

async function fetchAllItems() {
  const result = await callCloud('items', { action: 'get' })
  return (result.data || []).map(doc => ({
    _id: doc._id,
    id: doc.id,
    name: doc.name,
    expiryDate: doc.expiryDate,
    productionDate: doc.productionDate || '',
    alertDays: doc.alertDays || 1,
    category: doc.category || '',
    value: doc.value || 0,
    saved: doc.saved || false,
    savedAt: doc.savedAt || '',
    createdAt: doc.createdAt || ''
  }))
}

async function addItemToCloud(item) {
  const result = await callCloud('items', { action: 'add', item })
  return result.data
}

async function updateCloudItem(itemId, updates) {
  await callCloud('items', { action: 'update', itemId, updates })
}

async function deleteCloudItem(itemId) {
  await callCloud('items', { action: 'delete', itemId })
}

// --- 排行榜 / 成就系统 ---

function recordAdd() {
  return callCloud('leaderboard', { action: 'recordAdd' }).catch(() => {})
}

function recordSave() {
  return callCloud('leaderboard', { action: 'recordSave' }).catch(() => {})
}

function recordExpired() {
  return callCloud('leaderboard', { action: 'recordExpired' }).catch(() => {})
}

function getLeaderboardStats() {
  return callCloud('leaderboard', { action: 'getStats' })
}

// --- 订阅管理（保留直连数据库，频率低不影响调试） ---

async function updateSubscription(openid, enabled) {
  if (!wx.cloud || !openid) return

  const db = wx.cloud.database()
  const collection = db.collection(COLLECTION_SUBSCRIPTIONS)

  try {
    const existing = await collection.where({ openid }).get()

    if (existing.data.length > 0) {
      await collection.doc(existing.data[0]._id).update({
        data: { enabled, updatedAt: new Date().toISOString() }
      })
    } else {
      await collection.add({
        data: {
          openid,
          enabled,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      })
    }
  } catch (err) {
    console.error('更新订阅状态失败:', err)
  }
}

async function getSubscriptionStatus(openid) {
  if (!wx.cloud || !openid) return { enabled: false }

  const db = wx.cloud.database()
  const collection = db.collection(COLLECTION_SUBSCRIPTIONS)

  try {
    const res = await collection.where({ openid }).get()
    if (res.data.length > 0) {
      return { enabled: res.data[0].enabled }
    }
    return { enabled: false }
  } catch (err) {
    console.error('查询订阅状态失败:', err)
    return { enabled: false }
  }
}

module.exports = {
  getOpenid,
  fetchAllItems,
  addItemToCloud,
  updateCloudItem,
  deleteCloudItem,
  recordAdd,
  recordSave,
  recordExpired,
  getLeaderboardStats,
  updateSubscription,
  getSubscriptionStatus
}
