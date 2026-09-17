<?php
// Fixture for scripts/smoke-writes.mjs — never install it on a real site.
// The three Yoast keys in REST `meta`, writable by anyone who can edit the
// post. A fourth underscore key is registered WITHOUT an auth_callback, which
// WordPress then defaults to "deny", to exercise the 403 such a site returns.
// Term and comment keys cover the category, tag and comment tools.
add_action( 'init', function () {
	foreach ( array( '_yoast_wpseo_focuskw', '_yoast_wpseo_title', '_yoast_wpseo_metadesc' ) as $key ) {
		register_post_meta( '', $key, array(
			'type'          => 'string',
			'single'        => true,
			'show_in_rest'  => true,
			'auth_callback' => function ( $allowed, $meta_key, $post_id ) {
				return current_user_can( 'edit_post', $post_id );
			},
		) );
	}
	register_post_meta( '', '_locked_without_callback', array(
		'type'         => 'string',
		'single'       => true,
		'show_in_rest' => true,
	) );
	register_term_meta( '', 'term_note', array( 'type' => 'string', 'single' => true, 'show_in_rest' => true ) );
	register_meta( 'comment', 'comment_note', array( 'type' => 'string', 'single' => true, 'show_in_rest' => true ) );
} );
