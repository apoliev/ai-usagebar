import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {readConfig} from './lib/config.js';
import {Indicator} from './ui/indicator.js';

export default class AiUsagebarExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._placeIds = ['changed::panel-box', 'changed::panel-index']
            .map(signal => this._settings.connect(signal, () => this._place()));
        this._place();
    }

    // A panel item cannot change area in place, so a new position rebuilds it;
    // the cache's fresh TTL keeps that from refetching.
    _place() {
        this._indicator?.destroy();
        this._indicator = new Indicator(this._settings, () => this.openPreferences(), this.path);
        const {box, index} = readConfig(this._settings).panel;
        Main.panel.addToStatusArea(this.uuid, this._indicator, index, box);
    }

    disable() {
        for (const id of this._placeIds)
            this._settings.disconnect(id);
        this._placeIds = null;
        this._indicator.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
