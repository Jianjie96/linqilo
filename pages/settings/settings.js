const app = getApp()
const syncUtil = require('../../utils/sync.js')

Page({
  data: {
    totalItems: 0,
    isSubscribed: false,
    isSyncing: false,
    cloudEnabled: false,
    aboutInfo: {
      name: '叮咚到期',
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
    this.setData({
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

    wx.showActionSheet({
      itemList: ['分享为文本文件', '复制 JSON 到剪贴板'],
      success: (res) => {
        if (res.tapIndex === 0) {
          this.shareAsFile(items)
        } else {
          this.copyAsJSON(items)
        }
      }
    })
  },

  // 格式化为可读文本并分享为文件
  shareAsFile(items) {
    const now = new Date()
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    
    let text = `叮咚到期 · 数据导出\n`
    text += `导出时间：${dateStr}\n`
    text += `共 ${items.length} 条记录\n`
    text += `${'─'.repeat(30)}\n\n`

    const statusMap = { safe: '正常', warning: '临期', danger: '今日到期', expired: '已过期' }
    const util = require('../../utils/util.js')

    items.forEach((item, i) => {
      const days = util.calcDaysRemaining ? util.calcDaysRemaining(item.expiryDate) : 0
      const status = util.getItemStatus ? util.getItemStatus(item.expiryDate, item.alertDays) : 'unknown'
      const statusText = statusMap[status] || '未知'

      text += `${i + 1}. ${item.name}\n`
      text += `   分类：${item.category || '未分类'}\n`
      if (item.productionDate) text += `   生产日期：${item.productionDate}\n`
      text += `   到期日期：${item.expiryDate}\n`
      if (days >= 0) text += `   剩余天数：${days} 天\n`
      text += `   状态：${statusText}\n`
      if (item.alertDays) text += `   临期提醒：到期前 ${item.alertDays} 天\n`
      text += `\n`
    })

    text += `${'─'.repeat(30)}\n`
    text += `由「叮咚到期」小程序生成`

    const fs = wx.getFileSystemManager()
    const filePath = `${wx.env.USER_DATA_PATH}/dingdong-export-${dateStr}.txt`

    fs.writeFile({
      filePath,
      data: text,
      encoding: 'utf8',
      success: () => {
        wx.shareFileMessage({
          filePath,
          fileName: `叮咚到期数据_${dateStr}.txt`,
          success: () => {
            wx.showToast({ title: '已生成文件，请选择发送对象', icon: 'none' })
          },
          fail: (err) => {
            console.error('分享文件失败:', err)
            wx.showToast({ title: '分享失败，请重试', icon: 'none' })
          }
        })
      },
      fail: (err) => {
        console.error('写入文件失败:', err)
        wx.showToast({ title: '生成文件失败', icon: 'none' })
      }
    })
  },

  // 复制为 JSON（备用方案）
  copyAsJSON(items) {
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
      content: '叮咚到期 v1.0.0\n\n提前记录食品、证件、物品的到期日，临期时主动通知你，重要事情不再忘。',
      showCancel: false,
      confirmText: '知道了'
    })
  }
})
