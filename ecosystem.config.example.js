// pm2 部署配置模板
//
// 用法：在服务器上复制成 ecosystem.config.js，填入真实值，然后
//   cp ecosystem.config.example.js ecosystem.config.js
//   vi ecosystem.config.js        # 填 JMS_SERVICE / JMS_ID
//   chmod 600 ecosystem.config.js
//   pm2 delete jms-to-clash; pm2 start ecosystem.config.js; pm2 save
//
// 注意：ecosystem.config.js 含订阅凭据，已在 .gitignore 中排除，且部署时
// 不会被 rsync 覆盖（部署命令带 --exclude）。改完环境变量必须 delete 后
// 重新 start，pm2 restart 不会重新加载 env。
//
// 访问令牌不在这里配置——它存放在 tokens.txt，一行一个，改完即时生效，
// 用 scripts/token.sh 管理。

module.exports = {
  apps: [{
    name: 'jms-to-clash',
    script: 'src/index.js',
    cwd: '/home/deploy/projects/jms-to-clash',
    env: {
      PORT: 3000,
      TOKEN_FILE: '/home/deploy/projects/jms-to-clash/tokens.txt',
      JMS_SERVICE: '<你的 JMS service 编号>',
      JMS_ID: '<你的 JMS id>',
      // 可选：到期/流量告警（v2.2）。流量监控默认生效，以下两项增强需配置：
      // JMS_EXPIRES: '08-21',                               // 续费日；MM-DD 每年循环自动顺延，年付推荐
      // ALERT_WEBHOOK_URL: 'https://api.day.app/<key>/{title}/{body}',  // 推送地址
      // USAGE_CHECK_MINUTES: '60',                          // 用量轮询间隔
    },
  }],
};
