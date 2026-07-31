const app = getApp()
const syncUtil = require('../../utils/sync.js')

Page({
  data: {
    alertDays: 1,
    totalItems: 0,
    isSubscribed: false, // 是否已订阅通知
    isSyncing: false, // 是否正在同步
    cloudEnabled: false, // 云开发是否可用
    aboutInfo: {
      name: '到期了么',
      version: '1.0.0'
    }
  },

  onLoad() {
    this.loadSettings()
    this.checkCloudStatus()
  },

  onShow() {
    this.loadSettings()
    this.checkSubscriptionStatus()
  },

  loadSettings() {
    const settings = app.globalData.settings
    this.setData({
      alertDays: settings.alertDays,
      totalItems: app.globalData.items.length
    })
  },

  // 检查云开发状态
  checkCloudStatus() {
    this.setData({ cloudEnabled: !!wx.cloud })
    if (wx.cloud) {
      this.checkSubscriptionStatus()
    }
  },

  // 查询订阅状态
  async checkSubscriptionStatus() {
    const openid = app.globalData.openid
    if (!openid || !wx.cloud) return

    try {
      const status = await syncUtil.getSubscriptionStatus(openid)
      this.setData({ isSubscribed: status.enabled })
    } catch (err) {
      console.error('查询订阅状态失败:', err)
    }
  },

  // 开启临期通知
  async subscribeNotification() {
    if (!wx.cloud) {
      wx.showToast({ title: '云开发未启用', icon: 'none' })
      return
    }

    // 调用微信订阅消息授权
    wx.requestSubscribeMessage({
      tmplIds: ['68FxhLOgJgDwUZWFOZFunglKqFWCsHPq3vSwsKI9YPY'], // 替换为你的模板 ID
      success: async (res) => {
        console.log('订阅授权结果:', res)
        const openid = app.globalData.openid
        if (!openid) {
          wx.showToast({ title: '请先等待初始化完成', icon: 'none' })
          return
        }

        // 无论用户是否授权，都记录订阅状态
        await syncUtil.updateSubscription(openid, true)
        this.setData({ isSubscribed: true })

        wx.showToast({ title: '已开启通知', icon: 'success' })
      },
      fail: (err) => {
        console.error('订阅授权失败:', err)
        wx.showToast({ title: '授权失败，请重试', icon: 'none' })
      }
    })
  },

  // 关闭临期通知
  async unsubscribeNotification() {
    const openid = app.globalData.openid
    if (!openid) return

    wx.showModal({
      title: '关闭通知',
      content: '关闭后将不再收到临期提醒消息',
      success: async (res) => {
        if (res.confirm) {
          await syncUtil.updateSubscription(openid, false)
          this.setData({ isSubscribed: false })
          wx.showToast({ title: '已关闭', icon: 'success' })
        }
      }
    })
  },

  // 手动同步：从云端拉取最新数据
  async manualSync() {
    this.setData({ isSyncing: true })
    wx.showLoading({ title: '同步中...' })

    try {
      const items = await app.loadItems()
      wx.hideLoading()
      this.setData({ isSyncing: false, totalItems: items.length })
      wx.showToast({ title: `已同步 ${items.length} 条`, icon: 'success' })
    } catch (err) {
      wx.hideLoading()
      this.setData({ isSyncing: false })
      wx.showToast({ title: '同步失败', icon: 'none' })
    }
  },

  // 修改默认临期天数
  onAlertDaysChange(e) {
    const days = parseInt(e.currentTarget.dataset.value)
    this.setData({ alertDays: days })
    app.saveSettings({ alertDays: days })
    wx.showToast({ title: '已更新', icon: 'success' })
  },

  // 自定义天数输入
  onCustomAlertDays(e) {
    const days = parseInt(e.detail.value)
    if (isNaN(days) || days < 1 || days > 365) {
      wx.showToast({ title: '请输入 1-365 之间的天数', icon: 'none' })
      return
    }
    this.setData({ alertDays: days })
    app.saveSettings({ alertDays: days })
    wx.showToast({ title: '已更新', icon: 'success' })
  },

  // 清除所有数据（从云端逐条删除）
  clearAllData() {
    wx.showModal({
      title: '清除所有数据',
      content: '此操作将删除所有物品，且不可恢复！',
      confirmColor: '#FF3B30',
      confirmText: '确认清除',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '清除中...' })
          const items = [...app.globalData.items]
          for (const item of items) {
            try {
              await app.deleteItem(item.id)
            } catch (err) {
              console.error('删除失败:', item.id, err)
            }
          }
          wx.hideLoading()
          this.setData({ totalItems: 0 })
          wx.showToast({ title: '已清除', icon: 'success' })
        }
      }
    })
  },

  // 导出数据
  exportData() {
    const items = app.globalData.items
    if (items.length === 0) {
      wx.showToast({ title: '没有数据可导出', icon: 'none' })
      return
    }

    const text = JSON.stringify(items, null, 2)
    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showToast({ title: '已复制到剪贴板', icon: 'success' })
      }
    })
  },

  // 关于
  showAbout() {
    wx.showModal({
      title: '关于',
      content: '到期了么 v1.0.0\n\n一个简单好用的物品到期提醒工具。\n帮你管理食品、药品、化妆品等物品的保质期，不再浪费。',
      showCancel: false,
      confirmText: '知道了'
    })
  }
})
