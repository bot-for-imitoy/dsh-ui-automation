/* panel_gtk4_popover.c — probe fixture for GTK4 secondary surfaces.
 *
 * A GtkMenuButton whose GtkPopover holds three buttons, plus a status label.
 * Used to answer: are AT-SPI WINDOW coordinates for popover content relative to
 * the parent toplevel surface (usable with an X11-origin offset) or to the
 * popover's own surface (needs its own offset)?
 *
 * Build:
 *   gcc -O1 panel_gtk4_popover.c -o panel_gtk4_popover $(pkg-config --cflags --libs gtk4)
 */
#include <gtk/gtk.h>
#include <stdio.h>

static GtkWidget *g_status;
static int g_clicks;

static void name_widget(GtkWidget *w, const char *name)
{
    gtk_accessible_update_property(GTK_ACCESSIBLE(w), GTK_ACCESSIBLE_PROPERTY_LABEL, name, -1);
}

static void on_item(GtkButton *b, gpointer data)
{
    g_clicks++;
    const char *which = (const char *)data;
    char *s = g_strdup_printf("clicks=%d last=%s", g_clicks, which);
    gtk_label_set_text(GTK_LABEL(g_status), s);
    printf("%s\n", s);
    fflush(stdout);
    g_free(s);
    GtkWidget *popover = gtk_widget_get_ancestor(GTK_WIDGET(b), GTK_TYPE_POPOVER);
    if (popover != NULL)
        gtk_popover_popdown(GTK_POPOVER(popover));
}

int main(void)
{
    g_set_prgname("panel_gtk4_popover");
    gtk_init();

    GtkWidget *win = gtk_window_new();
    gtk_window_set_title(GTK_WINDOW(win), "GTK4 Popover");
    gtk_window_set_default_size(GTK_WINDOW(win), 400, 300);

    GtkWidget *box = gtk_box_new(GTK_ORIENTATION_VERTICAL, 6);
    gtk_widget_set_margin_start(box, 8);
    gtk_widget_set_margin_end(box, 8);
    gtk_widget_set_margin_top(box, 8);
    gtk_window_set_child(GTK_WINDOW(win), box);

    GtkWidget *plain = gtk_button_new_with_label("plain");
    name_widget(plain, "plain");
    g_signal_connect(plain, "clicked", G_CALLBACK(on_item), "plain");
    gtk_box_append(GTK_BOX(box), plain);

    GtkWidget *menu_button = gtk_menu_button_new();
    gtk_menu_button_set_label(GTK_MENU_BUTTON(menu_button), "menu");
    name_widget(menu_button, "menu");

    GtkWidget *popover = gtk_popover_new();
    GtkWidget *pbox = gtk_box_new(GTK_ORIENTATION_VERTICAL, 4);
    gtk_widget_set_margin_start(pbox, 6);
    gtk_widget_set_margin_end(pbox, 6);
    gtk_widget_set_margin_top(pbox, 6);
    gtk_widget_set_margin_bottom(pbox, 6);
    gtk_popover_set_child(GTK_POPOVER(popover), pbox);
    for (int i = 1; i <= 3; i++) {
        char name[16], label[32];
        g_snprintf(name, sizeof name, "item%d", i);
        g_snprintf(label, sizeof label, "popover item %d", i);
        GtkWidget *item = gtk_button_new_with_label(label);
        name_widget(item, name);
        static const char *names[] = {"item1", "item2", "item3"};
        g_signal_connect(item, "clicked", G_CALLBACK(on_item), (gpointer)names[i - 1]);
        gtk_box_append(GTK_BOX(pbox), item);
    }
    gtk_menu_button_set_popover(GTK_MENU_BUTTON(menu_button), popover);
    gtk_box_append(GTK_BOX(box), menu_button);

    g_status = gtk_label_new("clicks=0 last=");
    gtk_box_append(GTK_BOX(box), g_status);

    gtk_window_present(GTK_WINDOW(win));
    g_print("clicks=0 last=\n");
    g_main_loop_run(g_main_loop_new(NULL, FALSE));
    return 0;
}
