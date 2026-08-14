const cloudApi = require('./utils/sync.js')

App({
  globalData: {
    items: [],       // 内存缓存，不持久化
    settings: {
      alertDays: 1
    },
    openid: '',
    // 组队相关
    boundGroupId: null,   // 当前绑定的队伍 ID，null = 个人视角
    teams: [],            // 已加入的队伍列表
    boundTeamName: ''     // 当前绑定队伍名称（用于 UI 显示）
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

  // 云端初始化：获取 openid + 加载组队信息
  async initCloud() {
    try {
      this.globalData.openid = await cloudApi.getOpenid()
      await this.loadTeamInfo()
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

  // --- 物品操作（全部走云端，支持 groupId 上下文） ---

  // 获取当前绑定的 groupId
  getBoundGroupId() {
    return this.globalData.boundGroupId
  },

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
    const groupId = this.getBoundGroupId()
    this._loadItemsPromise = cloudApi.fetchAllItems(groupId)
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

  // 强制重新加载（切换绑定后调用）
  reloadItems() {
    this._lastLoadTime = 0
    this._loadItemsPromise = null
    this.globalData.items = []
    return this.loadItems()
  },

  // 添加物品
  async addItem(item) {
    item.id = Date.now().toString()
    item.createdAt = new Date().toISOString()

    const groupId = this.getBoundGroupId()
    const saved = await cloudApi.addItemToCloud(item, groupId)
    this.globalData.items.unshift(saved)
    return saved
  },

  // 更新物品
  async updateItem(id, updates) {
    const groupId = this.getBoundGroupId()
    await cloudApi.updateCloudItem(id, updates, groupId)

    const index = this.globalData.items.findIndex(i => i.id === id)
    if (index !== -1) {
      this.globalData.items[index] = { ...this.globalData.items[index], ...updates }
    }
  },

  // 删除物品
  async deleteItem(id) {
    const groupId = this.getBoundGroupId()
    await cloudApi.deleteCloudItem(id, groupId)
    this.globalData.items = this.globalData.items.filter(i => i.id !== id)
  },

  // 获取单个物品（从内存缓存）
  getItem(id) {
    return this.globalData.items.find(i => i.id === id)
  },

  // --- 组队操作 ---

  // 加载组队信息（队伍列表 + 当前绑定）
  async loadTeamInfo() {
    try {
      const result = await cloudApi.getMyTeams()
      const { teams, boundGroupId } = result.data || {}
      this.globalData.teams = teams || []
      this.globalData.boundGroupId = boundGroupId || null

      // 查找当前绑定队伍名称
      if (boundGroupId && teams) {
        const bound = teams.find(t => t.teamId === boundGroupId)
        this.globalData.boundTeamName = bound ? bound.name : ''
      } else {
        this.globalData.boundTeamName = ''
      }
    } catch (err) {
      console.error('加载组队信息失败:', err)
    }
  },

  // 切换绑定并重新加载数据
  async switchBinding(teamId) {
    await cloudApi.bindTeam(teamId)
    this.globalData.boundGroupId = teamId || null

    // 更新队伍名称
    if (teamId) {
      const bound = this.globalData.teams.find(t => t.teamId === teamId)
      this.globalData.boundTeamName = bound ? bound.name : ''
    } else {
      this.globalData.boundTeamName = ''
    }

    // 重新加载物品
    return this.reloadItems()
  }
})
