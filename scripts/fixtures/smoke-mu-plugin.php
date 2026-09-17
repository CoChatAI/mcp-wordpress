<?php
// Fixture for scripts/smoke-writes.mjs — never install it on a real site: the
// smoke/v1 routes below answer anyone.
//
// Meta: the three Yoast keys in REST `meta`, writable by anyone who can edit
// the post. A fourth underscore key is registered WITHOUT an auth_callback,
// which WordPress then defaults to "deny", to exercise the 403 such a site
// returns. Term and comment keys cover the category, tag and comment tools.
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

// Routes that exercise wordpress_request and get_endpoint_schema.
add_action( 'rest_api_init', function () {
	$redirect = function ( $url, $status ) {
		return function () use ( $url, $status ) {
			$response = new WP_REST_Response( null, $status );
			$response->header( 'Location', is_callable( $url ) ? $url() : $url );
			return $response;
		};
	};
	$open = array( 'permission_callback' => '__return_true' );

	// Echoes what arrived, so a test can see every query pair and the body.
	register_rest_route( 'smoke/v1', '/echo', $open + array(
		'methods'  => array( 'GET', 'POST' ),
		'callback' => function ( WP_REST_Request $request ) {
			return array(
				'method' => $request->get_method(),
				'query'  => $request->get_query_params(),
				'body'   => $request->get_json_params(),
			);
		},
	) );
	// Out of the REST API: the credentials must not follow.
	register_rest_route( 'smoke/v1', '/to-login', $open + array(
		'methods'  => 'GET',
		'callback' => $redirect( 'wp_login_url', 302 ),
	) );
	// Within the REST API: followed.
	register_rest_route( 'smoke/v1', '/to-echo', $open + array(
		'methods'  => 'GET',
		'callback' => $redirect( function () { return rest_url( 'smoke/v1/echo' ) . '?hopped=1'; }, 302 ),
	) );
	// A write redirected with its method kept, and with it dropped.
	register_rest_route( 'smoke/v1', '/write-307', $open + array(
		'methods'  => 'POST',
		'callback' => $redirect( function () { return rest_url( 'smoke/v1/echo' ); }, 307 ),
	) );
	register_rest_route( 'smoke/v1', '/write-302', $open + array(
		'methods'  => 'POST',
		'callback' => $redirect( function () { return rest_url( 'smoke/v1/echo' ); }, 302 ),
	) );
	register_rest_route( 'smoke/v1', '/loop', $open + array(
		'methods'  => 'GET',
		'callback' => $redirect( function () { return rest_url( 'smoke/v1/loop' ); }, 302 ),
	) );
	// An ordinary endpoint that happens to take an argument called `namespace`.
	register_rest_route( 'smoke/v1', '/takes-namespace', $open + array(
		'methods'  => 'GET',
		'args'     => array( 'namespace' => array( 'type' => 'string', 'required' => true ) ),
		'callback' => function () {
			return array( 'called' => true );
		},
	) );
} );
