const cloudApi = require('./utils/sync.js')

App({
  globalData: {
    items: [],       // 内存缓存，不持久化
    settings: {
      alertDays: 1
    },
    openid: '',
    // 组队相关
    mutedGroups: [],      // 推送静音目标集合（'personal' 或队伍 id），默认全部订阅
    viewGroupId: undefined, // 当前视角（同步后端）：undefined = 未初始化，null = 个人，队伍 id = 队伍视角
    teams: []             // 已加入的队伍列表
  },

  _loadItemsPromise: null,  // 防重入：复用正在进行的请求
  _lastLoadTime: 0,         // 上次加载时间戳，防止短时间内重复请求
  _onCloudInitedCallbacks: [], // 云端初始化完成回调（首页等页面用于视角就绪后刷新）

  onLaunch() {
    if (wx.cloud) {
      wx.cloud.init({ traceUser: true })
      this.initCloud()
    }
    this.loadSettings()
  },

  // 云端初始化：获取 openid + 加载组队信息（完成后视角就绪）
  async initCloud() {
    try {
      this.globalData.openid = await cloudApi.getOpenid()
      await this.loadTeamInfo()
    } catch (err) {
      console.error('云端初始化失败:', err)
    }
    this._notifyCloudInited()
  },

  // 注册云端初始化完成回调；若已初始化则立即执行
  onCloudInited(cb) {
    if (this.globalData.viewGroupId !== undefined) {
      cb()
    } else {
      this._onCloudInitedCallbacks.push(cb)
    }
  },

  _notifyCloudInited() {
    const cbs = this._onCloudInitedCallbacks
    this._onCloudInitedCallbacks = []
    cbs.forEach(cb => { try { cb() } catch (e) {} })
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

  // 获取当前「视角」的 groupId（物品 CRUD、统计、成就均按视角走）
  getViewGroupId() {
    return this.globalData.viewGroupId || null
  },

  // 判断目标（'personal' 或队伍 id）是否已静音
  isMuted(target) {
    return this.globalData.mutedGroups.includes(target)
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
    const groupId = this.getViewGroupId()
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

  // 强制重新加载（切换视角后调用）
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

    const groupId = this.getViewGroupId()
    const saved = await cloudApi.addItemToCloud(item, groupId)
    this.globalData.items.unshift(saved)
    return saved
  },

  // 更新物品（groupId 不传时按当前视角；详情页传物品归属的 groupId）
  async updateItem(id, updates, groupId) {
    const ctxGroupId = groupId === undefined ? this.getViewGroupId() : groupId
    await cloudApi.updateCloudItem(id, updates, ctxGroupId)

    const index = this.globalData.items.findIndex(i => i.id === id)
    if (index !== -1) {
      this.globalData.items[index] = { ...this.globalData.items[index], ...updates }
    }
  },

  // 删除物品（groupId 不传时按当前视角）
  async deleteItem(id, groupId) {
    const ctxGroupId = groupId === undefined ? this.getViewGroupId() : groupId
    await cloudApi.deleteCloudItem(id, ctxGroupId)
    this.globalData.items = this.globalData.items.filter(i => i.id !== id)
  },

  // 获取单个物品（从内存缓存）
  getItem(id) {
    return this.globalData.items.find(i => i.id === id)
  },

  // --- 组队操作 ---

  // 加载组队信息（队伍列表 + 静音订阅 + 后端视角；初始化/校验本地视角）
  async loadTeamInfo() {
    try {
      const result = await cloudApi.getMyTeams()
      const { teams, mutedGroups, viewGroupId } = result.data || {}
      this.globalData.teams = teams || []
      this.globalData.mutedGroups = Array.isArray(mutedGroups) ? mutedGroups : []

      // 视角与后端同步：若后端视角指向已退出的队伍，回退到个人视角
      const vg = viewGroupId || null
      const stillIn = vg ? this.globalData.teams.some(t => t.teamId === vg) : true
      this.globalData.viewGroupId = stillIn ? vg : null
    } catch (err) {
      console.error('加载组队信息失败:', err)
    }
  },

  // 切换视角（高频）：本地立即生效 + 轻量写库同步后端，失败不打扰用户
  switchView(teamId) {
    const target = teamId || null
    this.globalData.viewGroupId = target
    cloudApi.updateView(target).catch(() => {})
    // 清空物品缓存，调用方按新视角重新拉取
    this.globalData.items = []
    this._lastLoadTime = 0
    this._loadItemsPromise = null
  },

  // 切换推送静音（mute/unmute）：target 为 'personal' 或队伍 id
  async toggleMute(target) {
    const muted = !this.globalData.mutedGroups.includes(target)
    await cloudApi.muteTarget(target, muted)
    this.globalData.mutedGroups = muted
      ? this.globalData.mutedGroups.concat(target)
      : this.globalData.mutedGroups.filter(t => t !== target)
    return muted
  }
})
