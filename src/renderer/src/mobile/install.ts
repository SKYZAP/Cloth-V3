// Side-effect module: the phone entry imports this first so window.cloth exists before any other module reads it.
import { installBridge } from './bridge'

installBridge()
