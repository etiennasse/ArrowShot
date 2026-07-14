// ArrowShot preferences — shortcut, default color, default thickness, save folder.

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const COLOR_NAMES = ['red', 'orange', 'yellow', 'green', 'blue', 'white', 'black'];

export default class ArrowShotPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({title: 'ArrowShot'});
        page.add(group);
        window.add(page);

        // --- Capture shortcut -------------------------------------------
        const scRow = new Adw.ActionRow({
            title: 'Capture shortcut',
            subtitle: 'Key combo that starts a capture',
        });
        const scLabel = new Gtk.ShortcutLabel({
            valign: Gtk.Align.CENTER,
            disabled_text: 'Disabled',
            accelerator: settings.get_strv('capture-shortcut')[0] ?? '',
        });
        const scButton = new Gtk.Button({label: 'Set', valign: Gtk.Align.CENTER});
        scRow.add_suffix(scLabel);
        scRow.add_suffix(scButton);
        group.add(scRow);

        scButton.connect('clicked', () => {
            scButton.set_label('Press a key combo… (Esc to cancel)');
            scButton.set_sensitive(false);
            const controller = new Gtk.EventControllerKey();
            window.add_controller(controller);
            const done = () => {
                scButton.set_label('Set');
                scButton.set_sensitive(true);
                window.remove_controller(controller);
            };
            controller.connect('key-pressed', (_c, keyval, _keycode, state) => {
                if (keyval === Gdk.KEY_Escape) {
                    done();
                    return Gdk.EVENT_STOP;
                }
                const mask = state & Gtk.accelerator_get_default_mod_mask();
                if (!Gtk.accelerator_valid(keyval, mask))
                    return Gdk.EVENT_STOP; // wait for a real combo (ignore lone modifiers)
                const accel = Gtk.accelerator_name(keyval, mask);
                settings.set_strv('capture-shortcut', [accel]);
                scLabel.set_accelerator(accel);
                done();
                return Gdk.EVENT_STOP;
            });
        });

        // --- Default color ----------------------------------------------
        const colorModel = new Gtk.StringList();
        COLOR_NAMES.forEach(n => colorModel.append(n));
        const colorRow = new Adw.ComboRow({
            title: 'Default color',
            model: colorModel,
        });
        const curColor = settings.get_string('default-color');
        colorRow.set_selected(Math.max(0, COLOR_NAMES.indexOf(curColor)));
        colorRow.connect('notify::selected', () =>
            settings.set_string('default-color', COLOR_NAMES[colorRow.get_selected()]));
        group.add(colorRow);

        // --- Default thickness ------------------------------------------
        const widthRow = new Adw.SpinRow({
            title: 'Default thickness (px)',
            adjustment: new Gtk.Adjustment({
                lower: 2, upper: 40, step_increment: 1,
                value: settings.get_int('default-width'),
            }),
        });
        widthRow.connect('notify::value', () =>
            settings.set_int('default-width', Math.round(widthRow.get_value())));
        group.add(widthRow);

        // --- Save folder -------------------------------------------------
        const defaultLabel = 'Default (~/Pictures/Screenshots)';
        const dirRow = new Adw.ActionRow({
            title: 'Save folder',
            subtitle: settings.get_string('save-directory') || defaultLabel,
        });
        const chooseBtn = new Gtk.Button({label: 'Choose…', valign: Gtk.Align.CENTER});
        const clearBtn = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Use default folder',
        });
        dirRow.add_suffix(chooseBtn);
        dirRow.add_suffix(clearBtn);
        group.add(dirRow);

        chooseBtn.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: 'Select save folder', modal: true});
            dialog.select_folder(window, null, (dlg, res) => {
                try {
                    const folder = dlg.select_folder_finish(res);
                    if (folder) {
                        const path = folder.get_path();
                        settings.set_string('save-directory', path);
                        dirRow.set_subtitle(path);
                    }
                } catch (e) {
                    // dialog cancelled
                }
            });
        });
        clearBtn.connect('clicked', () => {
            settings.set_string('save-directory', '');
            dirRow.set_subtitle(defaultLabel);
        });
    }
}
