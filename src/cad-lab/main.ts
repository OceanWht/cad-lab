/**
 * CAD 图纸解析试验台的独立入口。
 * 与主应用 app 完全分离：不注册路由、不依赖 Pinia / Element Plus。
 */

import { createApp } from 'vue'
import CadLabApp from './CadLabApp.vue'
import './styles.css'

createApp(CadLabApp).mount('#cad-lab')
