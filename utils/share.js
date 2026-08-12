// 全局分享配置：让所有页面支持转发给好友和分享到朋友圈
// 用法：const shareMixin = require('../../utils/share.js')
//       Page({ ...shareMixin, ...页面自身逻辑 })
module.exports = {
  // 转发给好友（右上角菜单「转发」）
  onShareAppMessage() {
    return {
      title: '叮咚到期 · 提前记录，重要事情不再忘',
      path: '/pages/index/index'
    }
  },

  // 分享到朋友圈（右上角菜单「分享到朋友圈」）
  onShareTimeline() {
    return {
      title: '叮咚到期 · 提前记录，重要事情不再忘'
    }
  }
}
