const cloudApi = require('./utils/sync.js')

App({
  globalData: {
    items: [],       // 内存缓存，不持久化
    settings: {
      alertDays: 1
    },
    openid: ''
  },

  _loadItemsPromise: null,  // 防重入：复用正在进行的请求
  _lastLoadTime: 0,         // 上次加载时间戳，防止短时间内重复请求

  onLaunch() {
    if (wx.cloud) {
      wx.cloud.init({ traceUser: true })
      this.initCloud()
    }
    this.loadSettings()
  },

  // 云端初始化：获取 openid
  async initCloud() {
    try {
      this.globalData.openid = await cloudApi.getOpenid()
    } catch (err) {
      console.error('云端初始化失败:', err)
    }
  },

  // 设置（本地偏好，走 Storage）
  loadSettings() {
    try {
      const settings = wx.getStorageSync('settings')
      if (settings) this.globalData.settings = settings
    } catch (e) {}
  },

  saveSettings(settings) {
    this.globalData.settings = settings
    wx.setStorageSync('settings', settings)
  },

  // --- 物品操作（全部走云端） ---

  // 从云端加载所有物品（防重入 + 缓存）
  loadItems() {
    // 正在请求中，直接复用 Promise
    if (this._loadItemsPromise) return this._loadItemsPromise

    // 缓存未过期（5秒内），直接返回缓存数据
    const now = Date.now()
    if (this.globalData.items.length > 0 && now - this._lastLoadTime < 5000) {
      return Promise.resolve(this.globalData.items)
    }

    this._lastLoadTime = now
    this._loadItemsPromise = cloudApi.fetchAllItems()
      .then(items => {
        this.globalData.items = items
        return items
      })
      .catch(err => {
        console.error('加载物品失败:', err)
        return this.globalData.items
      })
      .finally(() => {
        this._loadItemsPromise = null
      })

    return this._loadItemsPromise
  },

  // 添加物品
  async addItem(item) {
    item.id = Date.now().toString()
    item.createdAt = new Date().toISOString()

    const saved = await cloudApi.addItemToCloud(item)
    this.globalData.items.unshift(saved)
    return saved
  },

  // 更新物品
  async updateItem(id, updates) {
    await cloudApi.updateCloudItem(id, updates)

    const index = this.globalData.items.findIndex(i => i.id === id)
    if (index !== -1) {
      this.globalData.items[index] = { ...this.globalData.items[index], ...updates }
    }
  },

  // 删除物品
  async deleteItem(id) {
    await cloudApi.deleteCloudItem(id)
    this.globalData.items = this.globalData.items.filter(i => i.id !== id)
  },

  // 获取单个物品（从内存缓存）
  getItem(id) {
    return this.globalData.items.find(i => i.id === id)
  }
})
