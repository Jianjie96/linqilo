const util = require('../../utils/util.js')
const syncUtil = require('../../utils/sync.js')
const app = getApp()
const shareMixin = require('../../utils/share.js')

Page({
  ...shareMixin,
  data: {
    item: null,
    daysRemaining: 0,
    status: '',
    statusText: '',
    countdownText: '',
    progressPercent: 0,
    isEditing: false,
    editName: '',
    editExpiryDate: '',
    editProductionDate: '',
    editAlertDays: 1,
    editValue: ''
  },

  onLoad(options) {
    this.itemId = options.id
    this.loadItem()
  },

  onShow() {
    this.loadItem()
  },

  // 加载物品数据
  loadItem() {
    const item = app.getItem(this.itemId)
    if (!item) {
      wx.showToast({ title: '物品不存在', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 1500)
      return
    }

    const alertDays = item.alertDays || app.globalData.settings.alertDays
    const daysRemaining = util.calcDaysRemaining(item.expiryDate)
    const status = util.getItemStatus(item.expiryDate, alertDays)
    const statusText = util.getStatusText(status)
    const countdownText = util.getCountdownText(item.expiryDate)

    // 消耗进度百分比（与首页卡片共用同一公式）
    const progressPercent = util.calcProgressPercent(item)

    this.setData({
      item: {
        ...item,
        createdAtFormatted: item.createdAt ? util.formatDate(item.createdAt) : ''
      },
      daysRemaining,
      status,
      statusText,
      countdownText,
      progressPercent
    })
  },

  // 开始编辑
  startEdit() {
    const { item } = this.data
    this.setData({
      isEditing: true,
      editName: item.name,
      editExpiryDate: item.expiryDate,
      editProductionDate: item.productionDate || '',
      editAlertDays: item.alertDays || app.globalData.settings.alertDays,
      editValue: String(item.value > 0 ? item.value : '')
    })
  },

  // 取消编辑
  cancelEdit() {
    this.setData({ isEditing: false })
  },

  // 编辑名称
  onEditNameInput(e) {
    this.setData({ editName: e.detail.value })
  },

  // 编辑到期日期
  onEditExpiryChange(e) {
    this.setData({ editExpiryDate: e.detail.value })
  },

  // 编辑生产日期
  onEditProductionChange(e) {
    this.setData({ editProductionDate: e.detail.value })
  },

  // 编辑提醒天数
  onEditAlertDaysChange(e) {
    this.setData({ editAlertDays: parseInt(e.currentTarget.dataset.value) })
  },

  // 编辑价值
  onEditValueInput(e) {
    this.setData({ editValue: e.detail.value })
  },

  // 标记已省钱
  async onSaveItem() {
    const { item } = this.data
    if (!item || item.saved || this.data.status === 'expired') return

    wx.showLoading({ title: '标记中...' })
    try {
      await app.updateItem(this.itemId, {
        saved: true,
        savedAt: new Date().toISOString()
      }, item.groupId || null)
      const cached = app.globalData.items.find(i => i.id === this.itemId)
      if (cached) {
        cached.saved = true
        cached.savedAt = new Date().toISOString()
      }
      syncUtil.recordSave(parseFloat(item.value) || 0, item.groupId || null, item.id)
      wx.hideLoading()
      wx.showToast({ title: '已省钱！', icon: 'success' })
      this.loadItem()
    } catch (err) {
      wx.hideLoading()
      console.error('标记省钱失败:', err)
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
    }
  },

  // 保存编辑
  async saveEdit() {
    const { editName, editExpiryDate, editProductionDate, editAlertDays, editValue } = this.data

    if (!editName.trim()) {
      wx.showToast({ title: '名称不能为空', icon: 'none' })
      return
    }

    if (!editExpiryDate) {
      wx.showToast({ title: '请选择到期日期', icon: 'none' })
      return
    }

    wx.showLoading({ title: '保存中...' })
    try {
      await app.updateItem(this.itemId, {
        name: editName.trim(),
        expiryDate: editExpiryDate,
        productionDate: editProductionDate,
        alertDays: editAlertDays,
        value: parseFloat(editValue) || 0
      }, this.data.item.groupId || null)
      wx.hideLoading()
      this.setData({ isEditing: false })
      this.loadItem()
      wx.showToast({ title: '已更新', icon: 'success' })
    } catch (err) {
      wx.hideLoading()
      console.error('更新失败:', err)
      wx.showToast({ title: '保存失败，请重试', icon: 'none' })
    }
  },

  // 删除物品
  deleteItem() {
    wx.showModal({
      title: '确认删除',
      content: `确定要删除「${this.data.item.name}」吗？`,
      confirmColor: '#FF3B30',
      confirmText: '删除',
      success: async (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '删除中...' })
          try {
            await app.deleteItem(this.itemId, this.data.item.groupId || null)

            // 记录统计数据：未省钱且未过期 = 避免过期（已省钱物品标记时已记录，避免重复计数）
            // 维度按物品归属判定：队伍物品记队伍，个人物品记个人
            const groupId = this.data.item.groupId || null
            if (!this.data.item.saved && this.data.daysRemaining >= 0) {
              syncUtil.recordSave(parseFloat(this.data.item.value) || 0, groupId, this.data.item.id)
            } else if (!this.data.item.saved) {
              syncUtil.recordExpired(groupId, this.data.item.id)
            }

            wx.hideLoading()
            wx.showToast({ title: '已删除', icon: 'success' })
            setTimeout(() => wx.navigateBack(), 1500)
          } catch (err) {
            wx.hideLoading()
            console.error('删除失败:', err)
            wx.showToast({ title: '删除失败，请重试', icon: 'none' })
          }
        }
      }
    })
  },

  // 分享
  onShareAppMessage() {
    const { item } = this.data
    return {
      title: `${item.name} - ${this.data.countdownText}`,
      path: `/pages/detail/detail?id=${this.itemId}`
    }
  }
})
