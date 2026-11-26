## Cloth is open source
- Cloth's code is now public on GitHub under the MIT licence. Issues and pull requests are welcome.
- Updates come straight from the public releases: no GitHub token to paste. Settings no longer asks for one. (Cloth 1.5.1 and older still need a token to find this update; without one, install it from the Releases page.)
- The built-in MCP presets that pointed at one person's home network are gone. Servers you already set up stay as they are.

## Models
- **LiteLLM** is a new provider. Connect a LiteLLM Proxy (`http://localhost:4000/v1`) with a virtual key or the master key, and **Fetch list** reads each model's context size, output limit, price (cache prices included), vision and the reasoning levels it takes from the proxy. Speech, transcription and rerank models are left out, and models on the proxy are priced even when it runs on this PC.
- With thinking off, Cloth sends "none" only to models that say they accept it; other models get no reasoning setting and use their default.

## Subagents
- Subagents get 100 steps by default, up from 30. A saved 30 is raised once; any other number you chose stays.

## Fixes
- A tooltip for a button near the top of the window opens below it, so the window's minimise, maximise and close buttons can't cover it, and tooltips near a side of the window stay whole.
